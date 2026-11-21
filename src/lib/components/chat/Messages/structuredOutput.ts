import { encode } from 'html-entities';
import { getDispatchedVisualizationPreviews } from '$lib/utils/visualizations/dispatch';
import { agentView, terminalView, type AgentView } from './agentViews';

import {
	deriveReasoningSummaryPreview,
	splitExplicitReasoningSummaries
} from '$lib/components/common/reasoningSummary';

export type OutputContentPart = {
	type?: string;
	text?: unknown;
	[key: string]: unknown;
};

export type OutputItem = {
	type?: string;
	id?: string;
	call_id?: string;
	name?: string;
	display_label?: string;
	display_labels?: { running?: string; completed?: string };
	status?: string;
	hidden?: boolean;
	tool_id?: string;
	tool_type?: string;
	tool_targets?: Record<string, { tool_id: string; tool_type: string }>;
	arguments?: unknown;
	content?: OutputContentPart[];
	summary?: OutputContentPart[] | string;
	output?: OutputContentPart[];
	files?: unknown;
	embeds?: unknown;
	code?: string;
	lang?: string;
	duration?: number | string | null;
	started_at?: number | string | null;
	ended_at?: number | string | null;
	action?: Record<string, unknown>;
	actions?: Array<Record<string, unknown>>;
	queries?: unknown[];
	[key: string]: unknown;
};

export type OutputDetailToken = {
	summary: string;
	text: string;
	view?: AgentView | null;
	attributes: {
		type: string;
		id?: string;
		name?: string;
		display_label?: string;
		running_label?: string;
		done?: string;
		duration?: string;
		// Timing stamped by the backend on reasoning / code-interpreter items
		// (epoch seconds); `duration` above is derived from the pair.
		started_at?: string;
		ended_at?: string;
		arguments?: string;
		files?: string;
		embeds?: string;
		output?: string;
		status?: string;
	};
};

export type OutputDisplayItem =
	| { type: 'visualization'; id: string; call: OutputItem; result?: OutputItem }
	| {
			type: 'message';
			id: string;
			text: string;
	  }
	| {
			type: 'image';
			id: string;
			src: string;
	  }
	| {
			type: 'detail_single';
			id: string;
			token: OutputDetailToken;
	  }
	| {
			type: 'detail_group';
			id: string;
			tokens: OutputDetailToken[];
	  }
	| {
			// The reply's process — its tool/code steps plus the content narrated
			// around them — collapsed into one collapsible group once the message
			// is done; the answer stays outside (see foldProcessGroups).
			type: 'process_group';
			id: string;
			items: OutputDisplayItem[];
	  }
	| {
			type: 'file';
			id: string;
			item: Record<string, unknown>;
	  }
	| {
			type: 'context_compaction';
			id: string;
			summary: string;
			status?: 'in_progress' | 'failed';
	  };

type ResponseStreamEvent = {
	type?: string;
	item_id?: string;
	output_index?: number;
	content_index?: number;
	summary_index?: number;
	item?: OutputItem;
	part?: OutputContentPart;
	delta?: unknown;
	text?: unknown;
	arguments?: unknown;
	response?: {
		output?: OutputItem[];
		[key: string]: unknown;
	};
	[key: string]: unknown;
};

const GROUPABLE_OUTPUT_TYPES = new Set([
	'reasoning',
	'function_call',
	'open_webui:code_interpreter',
	'web_search_call',
	'file_search_call',
	'computer_call'
]);

const OPENAI_TOOL_NAMES: Record<string, string> = {
	web_search_call: 'Web Search',
	file_search_call: 'File Search',
	computer_call: 'Computer Use'
};

function getTextFromParts(parts: OutputContentPart[] = []): string {
	return parts
		.map((part) => {
			if (part?.text === undefined || part?.text === null) {
				return '';
			}
			return typeof part.text === 'string' ? part.text : String(part.text);
		})
		.join('');
}

function stringifyAttribute(value: unknown): string {
	if (value === undefined || value === null) {
		return '';
	}
	if (typeof value === 'string') {
		return value;
	}
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function isDoneStatus(status?: string): boolean {
	return status === 'completed' || status === 'failed' || status === 'incomplete';
}

function getMessageText(item: OutputItem): string {
	return getTextFromParts(item.content ?? []);
}

function getReasoningText(item: OutputItem): string {
	// Summary parts are standalone blocks (like native reasoning summaries):
	// joining them inserts the part-boundary blank line the renderer expects.
	const summaryParts = Array.isArray(item.summary) && item.summary.length ? item.summary : null;
	if (summaryParts) {
		return summaryParts
			.filter((part) => typeof part?.text === 'string' && part.text.trim())
			.map((part) => part.text!)
			.join('\n\n');
	}
	// Content is the raw streamed chain of thought: one continuous text.
	return getTextFromParts(item.content ?? []);
}

export function getToolResultText(item?: OutputItem): string {
	return (item?.output ?? [])
		.filter((part) => part?.type !== 'input_image')
		.map((part) => {
			if (part?.text === undefined || part?.text === null) {
				return '';
			}
			return typeof part.text === 'string' ? part.text : String(part.text);
		})
		.join('');
}

function parseJSONStringValue(value: unknown): unknown {
	if (typeof value !== 'string') {
		return value;
	}

	let parsed: unknown = value.trim();
	while (typeof parsed === 'string') {
		try {
			parsed = JSON.parse(parsed);
		} catch {
			break;
		}
	}
	return parsed;
}

function getInlineFileFromToolOutput(callItem?: OutputItem, resultItem?: OutputItem) {
	if (!callItem || !resultItem || callItem.name !== 'display_file') {
		return null;
	}

	const args = parseJSONStringValue(callItem.arguments) as Record<string, unknown>;
	if (!args || typeof args !== 'object') {
		return null;
	}

	const result = parseJSONStringValue(getToolResultText(resultItem)) as Record<string, unknown>;
	const isTerminalFile = result?.source === 'open_terminal' && !!result.terminal_selector;
	const isOpenWebUIFile = result?.source === 'open_webui';
	if (
		!result ||
		typeof result !== 'object' ||
		result.type !== 'file' ||
		!result.path ||
		result.exists === false ||
		!(isTerminalFile || isOpenWebUIFile)
	) {
		return null;
	}

	return result.page === undefined && args.page !== undefined
		? { ...result, page: args.page }
		: result;
}

export function buildToolCallToken(
	item: OutputItem,
	toolOutputByCallId: Record<string, OutputItem>
) {
	const callId = item.call_id ?? item.id ?? '';
	const resultItem = toolOutputByCallId[callId];
	const status = String(item.status ?? '');
	const isPending = status === 'pending';
	const isDone = !!resultItem || status === 'failed' || status === 'incomplete';
	const isExecuting = !isDone && status === 'completed';
	let name = item.name ?? '';
	if (name === 'delegate_task') {
		try {
			const args =
				typeof item.arguments === 'string'
					? JSON.parse(item.arguments || '{}')
					: (item.arguments ?? {});
			const task = typeof args.task === 'string' && args.task ? args.task : '?';
			const label = args.background ? 'Background sub-agent' : 'Sub-agent';
			name = `${label}: "${task.length > 60 ? `${task.slice(0, 60)}...` : task}"`;
		} catch {
			name = 'Sub-agent';
		}
	}

	const text = getToolResultText(resultItem);
	return {
		summary: isPending
			? 'Tool Approval Needed'
			: isDone
				? 'Tool Executed'
				: isExecuting
					? 'Executing...'
					: 'Preparing...',
		text,
		view: agentView(item, text) ?? terminalView(item, text),
		attributes: {
			type: 'tool_calls',
			id: callId,
			name,
			running_label:
				typeof item.display_labels?.running === 'string' ? item.display_labels.running : '',
			display_label:
				typeof item.display_labels?.completed === 'string'
					? item.display_labels.completed
					: typeof item.display_label === 'string'
						? item.display_label
						: '',
			done: isDone ? 'true' : 'false',
			status,
			// ToolCallDisplay HTML-decodes these, like legacy <details> attributes.
			arguments: encode(stringifyAttribute(item.arguments ?? '')),
			files: encode(stringifyAttribute(resultItem?.files)),
			embeds: encode(stringifyAttribute(resultItem?.embeds))
		}
	};
}

// Reasoning is streamed as markdown; its live preview shows the last finalized
// summary title. A block still waiting on the next block's merge decision is
// held back. The preview is what `summary` carries for the whole lifetime of
// the item; the duration text shown once a reasoning block finishes is rendered
// separately.
function buildReasoningToken(item: OutputItem, isLastItem: boolean) {
	const duration = item.duration ?? '';
	const isDone = isDoneStatus(item.status) || item.duration !== undefined || !isLastItem;
	const reasoningText = getReasoningText(item);
	const cacheId = item.id ?? item.call_id ?? '';
	// The preview state is cached so a finished block is not re-scanned on every
	// render; `done` marks the state and consumers render the duration from
	// `attributes.duration` themselves. Summaries that carry their own title
	// (the reasoning_summary task) skip the derivation: their bold lead line is
	// the preview title directly.
	const explicitSummaries = splitExplicitReasoningSummaries(cacheId, reasoningText);
	const preview = explicitSummaries
		? ([...explicitSummaries].reverse().find((summary) => summary.title)?.title ?? '')
		: deriveReasoningSummaryPreview(cacheId, reasoningText, isDone);

	return {
		summary: preview,
		text: reasoningText,
		attributes: {
			type: 'reasoning',
			done: isDone ? 'true' : 'false',
			duration: String(duration),
			started_at: stringifyAttribute(item.started_at),
			ended_at: stringifyAttribute(item.ended_at)
		}
	};
}

function buildCodeInterpreterToken(item: OutputItem, isLastItem: boolean) {
	const duration = item.duration ?? '';
	const isDone = isDoneStatus(item.status) || item.duration !== undefined || !isLastItem;
	const code = item.code ?? '';
	const lang = item.lang ?? 'python';

	return {
		summary: isDone ? 'Analyzed' : 'Analyzing...',
		text: code ? `\`\`\`${lang}\n${code}\n\`\`\`` : '',
		attributes: {
			type: 'code_interpreter',
			done: isDone ? 'true' : 'false',
			duration: String(duration),
			started_at: stringifyAttribute(item.started_at),
			ended_at: stringifyAttribute(item.ended_at),
			output: stringifyAttribute(item.output)
		}
	};
}

function getOpenAIToolSummary(item: OutputItem): string {
	if (item.type === 'web_search_call') {
		const action = item.action ?? {};
		const actionType = action.type;
		if (actionType === 'search') {
			const queries = Array.isArray(action.queries) ? action.queries : [];
			const query = typeof action.query === 'string' ? action.query : '';
			return queries.length ? `Search: ${queries.join(', ')}` : query ? `Search: ${query}` : '';
		}
		if (actionType === 'open_page' && typeof action.url === 'string') {
			return `Open page: ${action.url}`;
		}
		if (actionType === 'find_in_page' && typeof action.pattern === 'string') {
			return `Find in page: ${action.pattern}`;
		}
	}

	if (item.type === 'file_search_call') {
		const queries = item.queries ?? [];
		return queries.length ? `Queries: ${queries.join(', ')}` : '';
	}

	if (item.type === 'computer_call') {
		if (item.action?.type) {
			return `Action: ${item.action.type}`;
		}
		if (Array.isArray(item.actions) && item.actions.length) {
			return `Actions: ${item.actions.map((action) => action.type ?? '?').join(', ')}`;
		}
	}

	return '';
}

function buildOpenAIToolToken(item: OutputItem, isLastItem: boolean) {
	const isDone = isDoneStatus(item.status) || !isLastItem;
	return {
		summary: isDone ? 'Tool Executed' : 'Executing...',
		text: getOpenAIToolSummary(item),
		attributes: {
			type: 'tool_calls',
			id: item.id ?? '',
			name: OPENAI_TOOL_NAMES[item.type ?? ''] ?? item.type ?? '',
			done: isDone ? 'true' : 'false',
			arguments: ''
		}
	};
}

function buildDetailToken(
	item: OutputItem,
	isLastItem: boolean,
	toolOutputByCallId: Record<string, OutputItem>
): OutputDetailToken | null {
	if (item.type === 'function_call') {
		return buildToolCallToken(item, toolOutputByCallId);
	}
	if (item.type === 'reasoning') {
		return buildReasoningToken(item, isLastItem);
	}
	if (item.type === 'open_webui:code_interpreter') {
		return buildCodeInterpreterToken(item, isLastItem);
	}
	if (item.type && OPENAI_TOOL_NAMES[item.type]) {
		return buildOpenAIToolToken(item, isLastItem);
	}
	return null;
}

export function isHiddenToolCall(item: OutputItem): boolean {
	return (
		item.type === 'function_call' &&
		item.hidden === true &&
		!['pending', 'queued', 'requires_approval'].includes(item.status ?? '')
	);
}

/**
 * Wall-clock seconds covered by a run of detail tokens.
 *
 * Only reasoning / code-interpreter tokens are timed: the backend stamps
 * `started_at` / `ended_at` (epoch seconds) on them and derives `duration` from the
 * pair; tool calls themselves are not timed. Prefers the span between the earliest
 * start and the latest end — which also counts the tool execution happening between
 * the steps — and falls back to summing the per-token `duration`. Returns 0 when
 * nothing usable was recorded.
 */
export function getDetailsDurationSeconds(tokens: OutputDetailToken[] = []): number {
	let earliestStart = Infinity;
	let latestEnd = -Infinity;
	let summedDuration = 0;

	for (const token of tokens) {
		const attributes = token?.attributes;
		if (attributes?.type !== 'reasoning' && attributes?.type !== 'code_interpreter') {
			continue;
		}

		const start = Number(attributes.started_at);
		if (Number.isFinite(start) && start > 0) {
			earliestStart = Math.min(earliestStart, start);
		}

		const end = Number(attributes.ended_at);
		if (Number.isFinite(end) && end > 0) {
			latestEnd = Math.max(latestEnd, end);
		}

		const duration = Number(attributes.duration ?? 0);
		if (Number.isFinite(duration) && duration > 0) {
			summedDuration += duration;
		}
	}

	if (earliestStart !== Infinity && latestEnd !== -Infinity && latestEnd > earliestStart) {
		return Math.round(latestEnd - earliestStart);
	}

	return Math.round(summedDuration);
}

/**
 * Number of calls a run of detail tokens made: tool calls plus code-interpreter
 * runs. A process group only forms around a non-reasoning detail, i.e. one of
 * these, so the count is never zero for a group.
 */
export function getDetailCallCount(tokens: OutputDetailToken[] = []): number {
	return tokens.filter(
		(token) =>
			token?.attributes?.type === 'tool_calls' || token?.attributes?.type === 'code_interpreter'
	).length;
}

/**
 * Mid-turn compaction appends its output marker at the moment the summary is
 * ready, but the marker chains to the oldest tool call that survived the cut
 * (`call_id`). Relocate the marker right above that call so the dashed line
 * marks the actual context boundary instead of trailing the rounds that were
 * emitted after the compaction ran. Markers without an anchor in this output
 * keep their original position.
 */
function anchorCompactionMarkers(output: OutputItem[]): OutputItem[] {
	const markerCount = output.filter(
		(item) => item?.type === 'open_webui:context_compaction' && item.call_id
	).length;
	if (!markerCount) {
		return output;
	}

	const anchored = [...output];
	for (const marker of output.filter(
		(item) => item?.type === 'open_webui:context_compaction' && item.call_id
	)) {
		const markerIndex = anchored.indexOf(marker);
		const anchorIndex = anchored.findIndex(
			(item) =>
				item?.type === 'function_call' &&
				(item.call_id === marker.call_id || item.id === marker.call_id)
		);
		// Only an earlier anchor is meaningful: the append position otherwise
		// already sits above the retained call.
		if (markerIndex >= 0 && anchorIndex >= 0 && anchorIndex < markerIndex) {
			anchored.splice(markerIndex, 1);
			anchored.splice(anchorIndex, 0, marker);
		}
	}
	return anchored;
}

const isProcessDetailItem = (item: OutputDisplayItem): boolean =>
	item.type === 'detail_single' || item.type === 'detail_group';

const isNonReasoningDetailItem = (item: OutputDisplayItem): boolean =>
	item.type === 'detail_group'
		? item.tokens.some((token) => token.attributes?.type !== 'reasoning')
		: item.type === 'detail_single'
			? item.token.attributes?.type !== 'reasoning'
			: false;

// Displayed artifacts are answer material, not process: they never fold.
const isProcessArtifactItem = (item: OutputDisplayItem): boolean =>
	item.type === 'visualization' || item.type === 'image' || item.type === 'file';

/**
 * Folds the reply's process into a `process_group`: a pure post-pass over the
 * flat items. The run spans everything up to and including the last detail;
 * what follows is the answer and stays top level. Artifacts are hoisted out of
 * the run, and the run folds only when it holds a non-reasoning detail — a
 * reasoning-only run stays flat, since reasoning is already collapsible.
 */
function foldProcessGroups(displayItems: OutputDisplayItem[], group: boolean): OutputDisplayItem[] {
	if (!group) {
		return displayItems;
	}

	let lastDetailIndex = -1;
	displayItems.forEach((item, index) => {
		if (isProcessDetailItem(item)) {
			lastDetailIndex = index;
		}
	});
	if (lastDetailIndex < 0 || lastDetailIndex === displayItems.length - 1) {
		return displayItems;
	}

	const run: OutputDisplayItem[] = [];
	const artifacts: OutputDisplayItem[] = [];
	for (const item of displayItems.slice(0, lastDetailIndex + 1)) {
		if (isProcessArtifactItem(item)) {
			artifacts.push(item);
		} else {
			run.push(item);
		}
	}

	if (!run.some(isNonReasoningDetailItem)) {
		// A reasoning-and-narration-only run renders the way it always did.
		return displayItems;
	}

	return [
		{
			type: 'process_group',
			// Tie the id to the run's first member for stable re-folds.
			id: `process-group-${run[0].id}`,
			items: run
		},
		...artifacts,
		...displayItems.slice(lastDetailIndex + 1)
	];
}

/**
 * `group` mirrors the message lifecycle: while streaming the caller passes
 * `false` and everything renders the way it always did; the process group
 * forms only once the message is done (see `foldProcessGroups`).
 */
export function buildOutputDisplayItems(
	output: OutputItem[] = [],
	forceInlineFiles = false,
	group = true
): OutputDisplayItem[] {
	output = anchorCompactionMarkers(output);

	const displayItems: OutputDisplayItem[] = [];
	const currentDetailTokens: OutputDetailToken[] = [];
	// Inline files held back while process grouping is active (see the file
	// branch below): they are emitted right after the detail run they belong
	// to, at the next flush, instead of cutting that run in two.
	const pendingFiles: OutputDisplayItem[] = [];
	const toolOutputByCallId: Record<string, OutputItem> = {};
	const toolCallByCallId: Record<string, OutputItem> = {};
	let idCounter = 0;
	const nextId = (prefix: string) => `${prefix}-${idCounter++}`;

	for (const item of output) {
		if (item?.type === 'function_call_output' && item.call_id) {
			toolOutputByCallId[item.call_id] = item;
		} else if (item?.type === 'function_call' && (item.call_id || item.id)) {
			toolCallByCallId[item.call_id ?? item.id ?? ''] = item;
		}
	}

	const flushDetails = () => {
		if (currentDetailTokens.length > 1) {
			displayItems.push({
				type: 'detail_group',
				id: nextId('detail-group'),
				tokens: [...currentDetailTokens]
			});
		} else if (currentDetailTokens.length === 1) {
			displayItems.push({
				type: 'detail_single',
				id: nextId('detail'),
				token: currentDetailTokens[0]
			});
		}
		currentDetailTokens.length = 0;
		displayItems.push(...pendingFiles.splice(0));
	};

	output.forEach((item, index) => {
		if (!item) {
			return;
		}

		for (const call of getDispatchedVisualizationPreviews(item)) {
			flushDetails();
			displayItems.push({ type: 'visualization', id: `visualization:${call.call_id}`, call });
		}

		if (isHiddenToolCall(item)) {
			return;
		}

		if (item.type === 'function_call_output') {
			const call = toolCallByCallId[item.call_id ?? ''];
			if (call && isHiddenToolCall(call)) return;

			const inlineFile = getInlineFileFromToolOutput(call, item);
			if (inlineFile && (inlineFile.displayed === true || forceInlineFiles)) {
				if (group) {
					// Process grouping is active, so the detail run will fold into
					// one group (and the file is hoisted out as an artifact anyway).
					// Flushing here would re-cut the run and shift the group's id
					// on every file, re-rendering (and re-collapsing) the group.
					pendingFiles.push({
						type: 'file',
						id: item.id ?? nextId('file'),
						item: inlineFile
					});
				} else {
					flushDetails();
					displayItems.push({
						type: 'file',
						id: item.id ?? nextId('file'),
						item: inlineFile
					});
				}
			}
			return;
		}

		if (
			item.type === 'function_call' &&
			item.name === 'ask_user' &&
			(item.status === 'pending' || item.status === 'in_progress')
		) {
			return;
		}

		if (
			item.type === 'function_call' &&
			item.tool_type === 'builtin' &&
			item.tool_id === 'builtin:render_visualization' &&
			(item.call_id || item.id)
		) {
			flushDetails();
			const callId = item.call_id ?? item.id!;
			displayItems.push({
				type: 'visualization',
				id: `visualization:${callId}`,
				call: item,
				result: toolOutputByCallId[callId]
			});
			return;
		}

		if (item.type && GROUPABLE_OUTPUT_TYPES.has(item.type)) {
			const token = buildDetailToken(item, index === output.length - 1, toolOutputByCallId);
			if (token) {
				currentDetailTokens.push(token);
			}
			return;
		}

		if (item.type === 'open_webui:context_compaction') {
			flushDetails();
			displayItems.push({
				type: 'context_compaction',
				id: item.id ?? nextId('context-compaction'),
				summary: typeof item.summary === 'string' ? item.summary : '',
				status: item.status === 'in_progress' || item.status === 'failed' ? item.status : undefined
			});
			return;
		}

		if (item.type === 'message') {
			const text = getMessageText(item);
			if (text.trim()) {
				flushDetails();
				displayItems.push({ type: 'message', id: item.id ?? nextId('message'), text });
			}
			return;
		}

		if (item.type === 'image_generation_call') {
			if (typeof item.result === 'string' && item.result) {
				flushDetails();
				displayItems.push({
					type: 'image',
					id: item.id ?? `image-${index}`,
					src: item.result.startsWith('data:')
						? item.result
						: `data:image/${item.output_format || 'png'};base64,${item.result}`
				});
			}
			return;
		}

		const fallbackText = getMessageText(item);
		if (fallbackText.trim()) {
			flushDetails();
			displayItems.push({ type: 'message', id: item.id ?? nextId('output'), text: fallbackText });
		}
	});

	flushDetails();

	const foldedItems = foldProcessGroups(displayItems, group);

	// Providers can reuse item ids across tool-call rounds.
	const seenIds = new Set<string>();
	foldedItems.forEach((displayItem, index) => {
		if (seenIds.has(displayItem.id)) {
			displayItem.id = `${displayItem.id}-${index}`;
		}
		seenIds.add(displayItem.id);
	});

	return foldedItems;
}

export function getOutputText(output?: OutputItem[] | null): string {
	return (output ?? [])
		.filter((item) => item?.type === 'message')
		.map(getMessageText)
		.filter((text) => text.trim())
		.join('\n');
}

function appendDelta(current: unknown, delta: unknown): unknown {
	if (typeof current === 'string' || typeof delta === 'string') {
		return `${current ?? ''}${delta ?? ''}`;
	}
	if (
		current &&
		delta &&
		typeof current === 'object' &&
		typeof delta === 'object' &&
		!Array.isArray(current) &&
		!Array.isArray(delta)
	) {
		return { ...(current as Record<string, unknown>), ...(delta as Record<string, unknown>) };
	}
	return delta ?? current ?? '';
}

function ensureOutputItem(
	output: OutputItem[],
	outputIndex: number,
	fallback?: OutputItem
): OutputItem {
	while (output.length <= outputIndex) {
		// Only the addressed slot gets the event's item; filler slots must not reuse its id.
		const item =
			output.length === outputIndex && fallback
				? { ...fallback }
				: { type: 'message', status: 'in_progress', role: 'assistant', content: [] };
		output.push(item);
	}
	output[outputIndex] = { ...output[outputIndex] };
	return output[outputIndex];
}

function ensurePart(parts: OutputContentPart[], index: number, fallback?: OutputContentPart) {
	while (parts.length <= index) {
		parts.push(fallback ?? { type: 'output_text', text: '' });
	}
	parts[index] = { ...parts[index] };
	return parts[index];
}

function setPart(
	parts: OutputContentPart[],
	index: number,
	part: OutputContentPart,
	fallback?: OutputContentPart
): void {
	// Assigning past the end leaves a hole that later spreads turn into undefined parts.
	ensurePart(parts, index, fallback);
	parts[index] = part;
}

function findOutputItemIndex(output: OutputItem[], item: OutputItem): number {
	return output.findIndex(
		(existing) =>
			(!!item.id && existing?.id === item.id) ||
			(!!item.call_id && existing?.type === item.type && existing?.call_id === item.call_id)
	);
}

function responseEventUpdatesOutputItem(eventType: string): boolean {
	return (
		eventType === 'response.content_part.added' ||
		eventType === 'response.reasoning_summary_part.added' ||
		eventType.endsWith('.delta') ||
		eventType.endsWith('.done')
	);
}

export function applyResponseStreamEvent(
	output: OutputItem[] = [],
	event: ResponseStreamEvent
): OutputItem[] {
	const eventType = event?.type ?? '';
	if (!eventType.startsWith('response.')) {
		return output;
	}

	if (eventType === 'response.completed') {
		if (!event.response?.output?.length) return output;

		// Completion covers one provider response, not the earlier tool-call rounds.
		const nextOutput = [...output];
		for (const item of event.response.output) {
			const index = findOutputItemIndex(nextOutput, item);
			if (index >= 0) {
				nextOutput[index] = item;
			} else {
				nextOutput.push(item);
			}
		}
		return nextOutput;
	}

	const nextOutput = [...output];
	const eventItemIndex = event.item_id
		? nextOutput.findIndex((item) => item?.id === event.item_id || item?.call_id === event.item_id)
		: -1;
	const outputIndex =
		eventItemIndex >= 0 ? eventItemIndex : (event.output_index ?? Math.max(output.length - 1, 0));

	if (eventType === 'response.output_item.added') {
		if (!event.item) {
			return output;
		}
		const item = { ...event.item };
		const existingIndex = findOutputItemIndex(nextOutput, item);
		if (existingIndex >= 0) {
			nextOutput[existingIndex] = item;
		} else if (outputIndex < nextOutput.length) {
			nextOutput.splice(outputIndex, 0, item);
		} else {
			nextOutput.push(item);
		}
		return nextOutput;
	}

	if (eventType === 'response.output_item.done') {
		if (!event.item) {
			return output;
		}
		const item = { ...event.item };
		const existingIndex = findOutputItemIndex(nextOutput, item);
		if (existingIndex >= 0) {
			nextOutput[existingIndex] = item;
		} else if (outputIndex < nextOutput.length) {
			nextOutput[outputIndex] = item;
		} else {
			nextOutput.push(item);
		}
		return nextOutput;
	}

	if (!responseEventUpdatesOutputItem(eventType)) {
		return output;
	}

	const item = ensureOutputItem(nextOutput, outputIndex, {
		id: event.item_id,
		type: eventType.includes('reasoning')
			? 'reasoning'
			: eventType.includes('function_call')
				? 'function_call'
				: 'message',
		status: 'in_progress',
		role: 'assistant',
		content: []
	});

	// When a reasoning event targets an existing empty message placeholder
	// (e.g. the trailing in_progress message appended before a tool call was
	// resumed), convert it into a reasoning item so the reasoning text is not
	// leaked as ordinary message output.
	const wantsReasoning =
		eventType.includes('reasoning') &&
		(eventType.endsWith('.delta') ||
			eventType.endsWith('.done') ||
			eventType.includes('reasoning_summary'));
	if (wantsReasoning && item.type !== 'reasoning') {
		const emptyMessage =
			item.type === 'message' &&
			(item.status === 'in_progress' || item.status === undefined) &&
			!(item.content ?? []).some((part) => typeof part?.text === 'string' && part.text.trim());
		if (emptyMessage) {
			item.type = 'reasoning';
			item.id = item.id ?? event.item_id;
			item.content = [];
			delete item.summary;
			item.status = 'in_progress';
			item.attributes = { type: 'reasoning_content' };
		}
	}

	if (eventType === 'response.content_part.added') {
		if (item.type === 'reasoning' || !event.part) {
			return nextOutput;
		}
		item.content = [...(item.content ?? [])];
		setPart(item.content, event.content_index ?? item.content.length, { ...event.part });
		return nextOutput;
	}

	if (eventType === 'response.reasoning_summary_part.added') {
		if (!event.part) {
			return nextOutput;
		}
		item.summary = Array.isArray(item.summary) ? [...item.summary] : [];
		const summaryIndex = event.summary_index ?? item.summary.length;
		setPart(item.summary, summaryIndex, { ...event.part }, { type: 'summary_text', text: '' });
		return nextOutput;
	}

	if (eventType.endsWith('.delta')) {
		const deltaType = eventType.split('.')[1];
		if (deltaType === 'function_call_arguments') {
			item.arguments = appendDelta(item.arguments ?? '', event.delta);
			return nextOutput;
		}

		if (deltaType === 'reasoning_summary_text') {
			const summaryIndex = event.summary_index ?? 0;
			item.summary = Array.isArray(item.summary) ? [...item.summary] : [];
			const part = ensurePart(item.summary, summaryIndex, { type: 'summary_text', text: '' });
			part.text = appendDelta(part.text ?? '', event.delta);
			return nextOutput;
		}

		if (item.type === 'open_webui:code_interpreter') {
			item.code = `${item.code ?? ''}${event.delta ?? ''}`;
			return nextOutput;
		}

		const key = deltaType === 'output_text' || deltaType === 'reasoning_text' ? 'text' : deltaType;
		item.content = [...(item.content ?? [])];
		const part = ensurePart(item.content, event.content_index ?? 0);
		part[key] = appendDelta(part[key], event.delta);
		return nextOutput;
	}

	if (eventType.endsWith('.done')) {
		const typeName = eventType.split('.')[1];
		if (typeName === 'content_part' && event.part) {
			item.content = [...(item.content ?? [])];
			const contentIndex = event.content_index ?? Math.max(item.content.length - 1, 0);
			setPart(item.content, contentIndex, { ...event.part });
		} else if (typeName === 'function_call_arguments' && event.arguments !== undefined) {
			item.arguments = event.arguments;
		} else if (
			(typeName === 'output_text' || typeName === 'text' || typeName === 'reasoning_text') &&
			event.text !== undefined
		) {
			item.content = [...(item.content ?? [])];
			const part = ensurePart(item.content, event.content_index ?? 0);
			part.text = event.text;
		}
	}

	return nextOutput;
}

export function replaceOutputMessageText(
	output: OutputItem[] = [],
	oldContent: string,
	newContent: string
): OutputItem[] {
	if (!oldContent) {
		return output;
	}

	let replaced = false;
	const nextOutput = output.map((item) => {
		if (replaced || item?.type !== 'message' || !Array.isArray(item.content)) {
			return item;
		}

		const partIndex = item.content.findIndex(
			(part) => typeof part?.text === 'string' && part.text.includes(oldContent)
		);
		if (partIndex === -1) {
			return item;
		}

		replaced = true;
		const nextContent = [...item.content];
		const part = nextContent[partIndex];
		nextContent[partIndex] = {
			...part,
			text: (part.text as string).replace(oldContent, () => newContent)
		};

		return {
			...item,
			content: nextContent
		};
	});

	return replaced ? nextOutput : output;
}

export function setOutputText(output: OutputItem[], text: string): OutputItem[] {
	if (text === getOutputText(output)) {
		return output;
	}

	const lastMessage = output.filter((item) => item?.type === 'message').at(-1);
	if (!lastMessage) {
		return [
			...output,
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }
		];
	}

	return output.map((item) =>
		item?.type === 'message'
			? { ...item, content: item === lastMessage ? [{ type: 'output_text', text }] : [] }
			: item
	);
}

function parseToolArguments(args: unknown): Record<string, unknown> {
	if (!args) {
		return {};
	}
	let value = args;
	while (typeof value === 'string') {
		try {
			value = JSON.parse(value);
		} catch {
			break;
		}
	}
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function getPendingAskUserFromMessage<T extends { role?: string; output?: unknown }>(
	message: T
) {
	if (message?.role !== 'assistant' || !Array.isArray(message.output)) {
		return null;
	}

	const call = message.output.find(
		(item: OutputItem) =>
			item?.type === 'function_call' &&
			item?.name === 'ask_user' &&
			item?.status === 'pending' &&
			(item?.call_id || item?.id)
	);

	if (call) {
		return { message, call, args: parseToolArguments(call.arguments) };
	}

	return null;
}
