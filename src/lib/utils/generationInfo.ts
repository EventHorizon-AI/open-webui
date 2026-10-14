/**
 * Turns a reply's raw provider usage data into a short, labeled summary for the
 * "generation info" tooltip.
 *
 * Providers report wildly different shapes for the same concepts (tokens,
 * speeds, durations, cost). This module maps the fields the supported
 * providers use (Ollama, OpenAI-style, llama.cpp, and Anthropic cache fields)
 * onto a small set of labeled sections, and pushes anything it does not
 * recognize into an "Other" section with a readable name.
 *
 * This module only produces data; `GenerationInfo.svelte` renders it and owns
 * the translated labels.
 */

export interface GenerationInfoRow {
	/** Semantic key used to look up a translated label. */
	key: string;
	/** Humanized fallback label for fields without a translation key. */
	label?: string;
	/** Formatted value, without the unit. */
	value: string;
	/** Unit to append to the value. */
	unit?: 'tokensPerSecond';
}

export interface GenerationInfoSection {
	key: 'speed' | 'tokens' | 'time' | 'cost' | 'other';
	/** True when the values come from the last of several model calls. */
	lastCall?: boolean;
	rows: GenerationInfoRow[];
}

export interface GenerationInfoOptions {
	/** BCP-47 locale used for number formatting. Defaults to the runtime locale. */
	locale?: string;
}

type Usage = Record<string, unknown>;

const INPUT_TOKEN_KEYS = ['input_tokens', 'prompt_tokens', 'prompt_eval_count'];
const OUTPUT_TOKEN_KEYS = ['output_tokens', 'completion_tokens', 'eval_count', 'predicted_n'];
const CACHED_INPUT_KEYS = [
	'prompt_eval_cached_count',
	'cache_n',
	'cache_read_input_tokens',
	'input_tokens_details.cached_tokens',
	'prompt_tokens_details.cached_tokens'
];
const COST_KEYS = [
	'cost',
	'total_cost',
	'input_cost',
	'output_cost',
	'prompt_cost',
	'completion_cost'
];
// Cost fields map to a shared semantic key so the component can translate them.
const COST_KEYS_BY_FIELD: Record<string, string> = {
	cost: 'cost',
	total_cost: 'totalCost',
	input_cost: 'inputCost',
	output_cost: 'outputCost',
	prompt_cost: 'promptCost',
	completion_cost: 'completionCost'
};
// Fields this module understands. Compact mode hides all of them from "Other"
// because each is represented by a labeled row above.
const KNOWN_KEYS = new Set([
	// Token counts
	'input_tokens',
	'output_tokens',
	'total_tokens',
	'prompt_tokens',
	'completion_tokens',
	'prompt_eval_count',
	'eval_count',
	'prompt_n',
	'cache_n',
	'predicted_n',
	'prompt_eval_cached_count',
	// Speeds
	'response_token/s',
	'prompt_token/s',
	'predicted_per_second',
	'prompt_per_second',
	// Ollama durations (nanoseconds)
	'total_duration',
	'load_duration',
	'prompt_eval_duration',
	'eval_duration',
	// llama.cpp timings (milliseconds)
	'prompt_ms',
	'prompt_per_token_ms',
	'predicted_ms',
	'predicted_per_token_ms',
	// Anthropic cache
	'cache_read_input_tokens',
	'cache_creation_input_tokens',
	// Detail blocks
	'prompt_tokens_details',
	'input_tokens_details',
	'completion_tokens_details',
	'output_tokens_details',
	// Costs
	...COST_KEYS,
	// Rounded duplicate of the Ollama total duration
	'approximate_total'
]);

// Canonical sums on one side, provider alias on the other. When the sum is
// larger than the alias, usage was merged from several model calls (tools),
// and the alias keeps only the last call's value.
const MERGED_INPUT_ALIASES = ['prompt_eval_count', 'prompt_tokens'];
const MERGED_OUTPUT_ALIASES = ['eval_count', 'completion_tokens', 'predicted_n'];

const isPlainObject = (value: unknown): value is Usage =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const toFiniteNumber = (value: unknown): number | null => {
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed === '') return null;
		const parsed = Number(trimmed);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
};

const readPath = (source: unknown, path: string): unknown => {
	const parts = path.split('.');
	let current: unknown = source;
	for (const part of parts) {
		if (!isPlainObject(current)) return undefined;
		current = current[part];
	}
	return current;
};

const firstNumber = (usage: Usage, keys: string[]): number | null => {
	for (const key of keys) {
		const value = toFiniteNumber(readPath(usage, key));
		if (value !== null) return value;
	}
	return null;
};

const hasKey = (usage: Usage, key: string): boolean => {
	const value = readPath(usage, key);
	return value !== undefined && value !== null && value !== '';
};

/** True when the field is missing, zero, empty, or a provider's "not measured" marker. */
const isUnmeasured = (value: unknown): boolean => {
	if (value === undefined || value === null) return true;
	if (typeof value === 'boolean') return false;
	if (typeof value === 'number') return !Number.isFinite(value) || value === 0;
	if (typeof value === 'string') {
		const normalized = value.trim().toLowerCase();
		if (normalized === '' || normalized === 'n/a' || normalized === 'nan' || normalized === '-') {
			return true;
		}
		const numeric = Number(normalized);
		return Number.isFinite(numeric) ? numeric === 0 : false;
	}
	return false;
};

const humanizeKey = (key: string): string =>
	(key.split('.').pop() ?? key)
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim()
		.replace(/^./, (char) => char.toUpperCase());

const formatCount = (value: number, locale?: string): string =>
	new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);

const formatSpeed = (value: number, locale?: string): string =>
	new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

const formatDecimal = (value: number, locale?: string): string => {
	const absolute = Math.abs(value);
	// Amounts below one whole unit keep four significant digits, so a tiny cost
	// never rounds away to zero.
	if (absolute !== 0 && absolute < 1) {
		return new Intl.NumberFormat(locale, { maximumSignificantDigits: 4 }).format(value);
	}
	return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(value);
};

/** Formats a millisecond duration in whichever unit reads best. */
export const formatDuration = (milliseconds: number, locale?: string): string => {
	const absolute = Math.abs(milliseconds);
	const format = (value: number, unit: string) =>
		`${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit}`;

	if (absolute === 0) return format(0, 'ms');
	if (absolute < 1) return format(milliseconds * 1000, 'µs');
	if (absolute < 1000) return format(milliseconds, 'ms');
	if (absolute < 60_000) return format(milliseconds / 1000, 's');
	if (absolute < 3_600_000) return format(milliseconds / 60_000, 'min');
	return format(milliseconds / 3_600_000, 'h');
};

const formatUnknown = (value: unknown, locale?: string): string => {
	if (value === null || value === undefined) return '';
	if (typeof value === 'boolean') return value ? 'true' : 'false';
	const numeric = toFiniteNumber(value);
	if (numeric !== null) {
		return Number.isInteger(numeric)
			? formatCount(numeric, locale)
			: formatDecimal(numeric, locale);
	}
	if (isPlainObject(value) || Array.isArray(value)) return JSON.stringify(value);
	return String(value);
};

// -- Value extraction ------------------------------------------------------

const inputTokenValue = (usage: Usage): number | null => {
	const direct = firstNumber(usage, INPUT_TOKEN_KEYS);
	if (direct !== null) return direct;
	const promptN = toFiniteNumber(readPath(usage, 'prompt_n'));
	const cacheN = toFiniteNumber(readPath(usage, 'cache_n'));
	if (promptN !== null || cacheN !== null) return (promptN ?? 0) + (cacheN ?? 0);
	return null;
};

const outputTokenValue = (usage: Usage): number | null => firstNumber(usage, OUTPUT_TOKEN_KEYS);

const totalTokenValue = (usage: Usage): number | null => {
	const total = toFiniteNumber(readPath(usage, 'total_tokens'));
	if (total !== null) return total;
	const input = inputTokenValue(usage);
	const output = outputTokenValue(usage);
	if (input === null && output === null) return null;
	return (input ?? 0) + (output ?? 0);
};

const cachedInputTokenValue = (usage: Usage): number | null =>
	firstNumber(usage, CACHED_INPUT_KEYS);

const promptDurationMs = (usage: Usage): number | null => {
	const nanoseconds = toFiniteNumber(readPath(usage, 'prompt_eval_duration'));
	if (nanoseconds !== null && nanoseconds > 0) return nanoseconds / 1e6;
	const milliseconds = toFiniteNumber(readPath(usage, 'prompt_ms'));
	if (milliseconds !== null && milliseconds > 0) return milliseconds;
	const perToken = toFiniteNumber(readPath(usage, 'prompt_per_token_ms'));
	const count = inputTokenValue(usage);
	if (perToken !== null && count !== null) return perToken * count;
	return null;
};

const responseDurationMs = (usage: Usage): number | null => {
	const nanoseconds = toFiniteNumber(readPath(usage, 'eval_duration'));
	if (nanoseconds !== null && nanoseconds > 0) return nanoseconds / 1e6;
	const milliseconds = toFiniteNumber(readPath(usage, 'predicted_ms'));
	if (milliseconds !== null && milliseconds > 0) return milliseconds;
	const perToken = toFiniteNumber(readPath(usage, 'predicted_per_token_ms'));
	const count = outputTokenValue(usage);
	if (perToken !== null && count !== null) return perToken * count;
	return null;
};

const totalDurationMs = (usage: Usage): number | null => {
	const nanoseconds = toFiniteNumber(readPath(usage, 'total_duration'));
	if (nanoseconds !== null && nanoseconds > 0) return nanoseconds / 1e6;
	return null;
};

const responseSpeed = (usage: Usage): number | null => {
	const direct = firstNumber(usage, ['response_token/s', 'predicted_per_second']);
	if (direct !== null && direct > 0) return direct;
	const count = outputTokenValue(usage);
	const duration = responseDurationMs(usage);
	if (count !== null && duration !== null && duration > 0) return count / (duration / 1000);
	return null;
};

const promptSpeed = (usage: Usage): number | null => {
	const direct = firstNumber(usage, ['prompt_token/s', 'prompt_per_second']);
	if (direct !== null && direct > 0) return direct;
	const count = inputTokenValue(usage);
	const duration = promptDurationMs(usage);
	if (count !== null && duration !== null && duration > 0) return count / (duration / 1000);
	return null;
};

/**
 * Detects that a usage payload was merged from several model calls. The
 * backend sums the canonical token fields but keeps only the last call's
 * provider aliases, so a canonical sum larger than its alias is the giveaway.
 */
export const isMergedUsage = (usage: unknown): boolean => {
	if (!isPlainObject(usage)) return false;

	const canonicalInput = toFiniteNumber(usage.input_tokens);
	const aliasInput = firstNumber(usage, MERGED_INPUT_ALIASES);
	if (canonicalInput !== null && aliasInput !== null && canonicalInput > aliasInput) return true;

	const canonicalOutput = toFiniteNumber(usage.output_tokens);
	const aliasOutput = firstNumber(usage, MERGED_OUTPUT_ALIASES);
	if (canonicalOutput !== null && aliasOutput !== null && canonicalOutput > aliasOutput)
		return true;

	return false;
};

// -- Section building ------------------------------------------------------

export const buildGenerationInfo = (
	usage: unknown,
	options: GenerationInfoOptions = {}
): GenerationInfoSection[] | null => {
	if (!isPlainObject(usage)) return null;

	const { locale } = options;
	const merged = isMergedUsage(usage);

	const addRow = (
		rows: GenerationInfoRow[],
		key: string,
		value: string,
		source: {
			raw?: unknown;
			label?: string;
			unit?: GenerationInfoRow['unit'];
		} = {}
	): void => {
		if (source.raw !== undefined && isUnmeasured(source.raw)) return;
		rows.push({ key, label: source.label, value, unit: source.unit });
	};

	const speedRows: GenerationInfoRow[] = [];
	const tokenRows: GenerationInfoRow[] = [];
	const timeRows: GenerationInfoRow[] = [];
	const costRows: GenerationInfoRow[] = [];

	const speed = responseSpeed(usage);
	if (speed !== null) {
		addRow(speedRows, 'responseSpeed', formatSpeed(speed, locale), {
			raw: speed,
			unit: 'tokensPerSecond'
		});
	}

	const promptSpeedValue = promptSpeed(usage);
	if (promptSpeedValue !== null) {
		addRow(speedRows, 'promptSpeed', formatSpeed(promptSpeedValue, locale), {
			raw: promptSpeedValue,
			unit: 'tokensPerSecond'
		});
	}

	const inputTokens = inputTokenValue(usage);
	if (inputTokens !== null) {
		addRow(tokenRows, 'inputTokens', formatCount(inputTokens, locale), {
			raw: inputTokens
		});
	}

	const cachedInputTokens = cachedInputTokenValue(usage);
	if (cachedInputTokens !== null) {
		addRow(tokenRows, 'cachedInputTokens', formatCount(cachedInputTokens, locale), {
			raw: cachedInputTokens
		});
	}

	if (hasKey(usage, 'cache_creation_input_tokens')) {
		const cacheWrite = toFiniteNumber(readPath(usage, 'cache_creation_input_tokens')) ?? 0;
		addRow(tokenRows, 'cacheWriteTokens', formatCount(cacheWrite, locale), {
			raw: cacheWrite
		});
	}

	const outputTokens = outputTokenValue(usage);
	if (outputTokens !== null) {
		addRow(tokenRows, 'outputTokens', formatCount(outputTokens, locale), {
			raw: outputTokens
		});
	}

	const reasoningTokens = firstNumber(usage, [
		'completion_tokens_details.reasoning_tokens',
		'output_tokens_details.reasoning_tokens'
	]);
	if (reasoningTokens !== null) {
		addRow(tokenRows, 'reasoningTokens', formatCount(reasoningTokens, locale), {
			raw: reasoningTokens
		});
	}

	const audioTokens = firstNumber(usage, [
		'completion_tokens_details.audio_tokens',
		'output_tokens_details.audio_tokens',
		'prompt_tokens_details.audio_tokens',
		'input_tokens_details.audio_tokens'
	]);
	if (audioTokens !== null) {
		addRow(tokenRows, 'audioTokens', formatCount(audioTokens, locale), {
			raw: audioTokens
		});
	}

	for (const [field, key] of [
		['accepted_prediction_tokens', 'acceptedPredictionTokens'],
		['rejected_prediction_tokens', 'rejectedPredictionTokens']
	] as const) {
		const value = firstNumber(usage, [
			`completion_tokens_details.${field}`,
			`output_tokens_details.${field}`,
			`prompt_tokens_details.${field}`,
			`input_tokens_details.${field}`
		]);
		if (value !== null) {
			addRow(tokenRows, key, formatCount(value, locale), {
				raw: value
			});
		}
	}

	const totalTokens = totalTokenValue(usage);
	if (totalTokens !== null) {
		addRow(tokenRows, 'totalTokens', formatCount(totalTokens, locale), {
			raw: totalTokens
		});
	}

	const totalDuration = totalDurationMs(usage);
	if (totalDuration !== null) {
		addRow(timeRows, 'totalTime', formatDuration(totalDuration, locale), {
			raw: totalDuration
		});
	}

	const loadDuration = toFiniteNumber(readPath(usage, 'load_duration'));
	if (loadDuration !== null) {
		addRow(timeRows, 'modelLoad', formatDuration(loadDuration / 1e6, locale), {
			raw: loadDuration
		});
	}

	const promptDuration = promptDurationMs(usage);
	if (promptDuration !== null) {
		addRow(timeRows, 'promptProcessing', formatDuration(promptDuration, locale), {
			raw: promptDuration
		});
	}

	const responseDuration = responseDurationMs(usage);
	if (responseDuration !== null) {
		addRow(timeRows, 'responseGeneration', formatDuration(responseDuration, locale), {
			raw: responseDuration
		});
	}

	for (const field of COST_KEYS) {
		const value = toFiniteNumber(readPath(usage, field));
		if (value === null) continue;
		addRow(costRows, COST_KEYS_BY_FIELD[field] ?? field, formatDecimal(value, locale), {
			raw: value,
			label: humanizeKey(field)
		});
	}

	// Anything left over keeps its readable name so no provider field is lost.
	const otherRows: GenerationInfoRow[] = [];
	for (const [field, rawValue] of Object.entries(usage)) {
		if (KNOWN_KEYS.has(field)) continue;
		if (isUnmeasured(rawValue)) continue;
		otherRows.push({
			key: field,
			label: humanizeKey(field),
			value: formatUnknown(rawValue, locale)
		});
	}

	const sections: GenerationInfoSection[] = [];
	const push = (key: GenerationInfoSection['key'], rows: GenerationInfoRow[], lastCall = false) => {
		if (rows.length === 0) return;
		// Drop rows that repeat another value (provider aliases of the same field).
		const deduped = rows.filter(
			(row, index) => rows.findIndex((other) => other.key === row.key) === index
		);
		sections.push({ key, rows: deduped, lastCall: lastCall || undefined });
	};

	push('speed', speedRows, merged);
	push('tokens', tokenRows);
	push('time', timeRows, merged);
	push('cost', costRows);
	push('other', otherRows);

	return sections;
};

/**
 * Renders a usage payload the way the generation info tooltip showed it before
 * this summary existed: one `key: value` line per field.
 */
export const formatRawGenerationInfo = (usage: unknown): string => {
	if (usage === undefined || usage === null) return '';

	let json: string;
	try {
		json = JSON.stringify(usage, null, 2);
	} catch {
		return '';
	}
	if (!json) return '';

	// The pretty-printed object starts with a newline; drop it so the <pre> does
	// not open with a blank line (an HTML parser would strip it anyway).
	return json
		.replace(/"([^(")"]+)":/g, '$1:')
		.slice(1, -1)
		.split('\n')
		.map((line) => line.slice(2))
		.map((line) => (line.endsWith(',') ? line.slice(0, -1) : line))
		.join('\n')
		.replace(/^\n/, '');
};
