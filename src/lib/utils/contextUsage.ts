type ContextMessage = {
	content?: unknown;
	output?: unknown[];
	tool_calls?: unknown;
	files?: unknown[];
	usage?: Record<string, unknown>;
	info?: { usage?: Record<string, unknown> };
};

export const estimateTokens = (value: unknown): number => {
	if (value === null || value === undefined || value === '') return 0;
	if (typeof value !== 'string') {
		try {
			value = JSON.stringify(value);
		} catch {
			value = String(value);
		}
	}
	return Math.max(1, Math.floor(String(value).length / 4));
};

// Streamed `output` arrays grow per token and used to be JSON.stringify'd on
// every estimate — O(total bytes) with a full copy per call. Sizing the value
// graph without serializing is O(nodes) and allocates nothing.
const estimateValueChars = (value: unknown): number => {
	switch (typeof value) {
		case 'string':
			return value.length + 2;
		case 'number':
		case 'boolean':
			return 5;
		case 'object': {
			if (value === null) return 4;
			let chars = 2;
			if (Array.isArray(value)) {
				for (const item of value) chars += estimateValueChars(item);
			} else {
				for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
					chars += key.length + 3 + estimateValueChars(item);
				}
			}
			return chars;
		}
		default:
			return 0;
	}
};

export const estimateOutputTokens = (output: unknown): number => {
	if (!Array.isArray(output)) return estimateTokens(output);
	return Math.max(1, Math.floor(estimateValueChars(output) / 4));
};

// Files do not grow while a response streams, but they were re-serialized (and
// scanned by the base64-stripping regex) for every message on every estimate.
const filesEstimateCache = new WeakMap<object, number>();

const estimateFilesTokens = (files: unknown[]): number => {
	const cached = filesEstimateCache.get(files);
	if (cached !== undefined) return cached;
	const estimated = estimateTokens(
		JSON.stringify(files).replace(/data:[\w/+.;=%-]*;base64,[A-Za-z0-9+/=]*/g, '')
	);
	filesEstimateCache.set(files, estimated);
	return estimated;
};

export const estimateMessagesTokens = (messages: ContextMessage[]): number =>
	messages.reduce((total, message) => {
		// Structured output already includes the assistant text and tool calls.
		let next = total + 4;
		next += message.output?.length
			? estimateOutputTokens(message.output)
			: estimateTokens(message.content) + estimateTokens(message.tool_calls);
		if (message.files?.length) {
			next += estimateFilesTokens(message.files);
		}
		return next;
	}, 0);

// Usage objects survive message copies between streaming events. Weak keys let old
// checkpoints disappear when a new usage snapshot or chat replaces them.
const usageCheckpoints = new WeakMap<object, number>();

export const captureUsageCheckpoint = (message: ContextMessage): void => {
	const usage = message.usage ?? message.info?.usage;
	if (usage) usageCheckpoints.set(usage, estimateMessagesTokens([message]));
};

export const estimateUsageGrowth = (message: ContextMessage): number => {
	const usage = message.usage ?? message.info?.usage;
	if (!usage) return 0;
	const tokens = estimateMessagesTokens([message]);
	if (!usageCheckpoints.has(usage)) {
		// shortcut: loaded chats anchor here; persist checkpoints if reloads must retain in-flight estimates.
		usageCheckpoints.set(usage, tokens);
	}
	return Math.max(0, tokens - usageCheckpoints.get(usage)!);
};
