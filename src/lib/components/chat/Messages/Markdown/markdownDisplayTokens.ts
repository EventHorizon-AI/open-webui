export const GROUPABLE_DETAIL_TYPES = new Set(['tool_calls', 'reasoning', 'code_interpreter']);

export type MarkdownDisplayToken = {
	type: string;
	id?: string;
	items?: any[];
	[key: string]: any;
};

export const isGroupableDetailToken = (token: any): boolean =>
	token?.type === 'details' && GROUPABLE_DETAIL_TYPES.has(token?.attributes?.type ?? '');

const isDetailToken = (token: any): boolean =>
	token?.type === 'detail_group' || isGroupableDetailToken(token);

const isNonReasoningDetailToken = (token: any): boolean =>
	token?.type === 'detail_group'
		? (token.items ?? []).some((item: any) => item?.attributes?.type !== 'reasoning')
		: isGroupableDetailToken(token) && token?.attributes?.type !== 'reasoning';

/**
 * Compiles a flat list of marked block tokens into the tokens the markdown
 * renderer actually draws, mirroring `buildOutputDisplayItems` in
 * structuredOutput.ts: consecutive groupable `<details>` blocks become one
 * `detail_group` token, and once the message is done (`group`) the run before
 * the final answer folds into one `process_group` token (see
 * `foldProcessRun`). Hidden tool calls are dropped entirely.
 */
export function buildMarkdownDisplayTokens(
	tokenList: any[] = [],
	group = true
): MarkdownDisplayToken[] {
	return buildMarkdownDisplayTokensStable(tokenList, group);
}

// The wrapper objects below are rebuilt only when their source
// token or group composition actually changes, so Svelte's keyed each blocks
// see identical references for the stable prefix of a streaming reply and skip
// re-rendering it every frame. Output values are the same as the uncached
// path; only object identity differs.
// ---------------------------------------------------------------------------

const plainWrapperCache = new WeakMap<object, { index: number; wrapper: MarkdownDisplayToken }>();
const loneDetailCache = new WeakMap<object, { index: number; wrapper: MarkdownDisplayToken }>();
const detailGroupCache = new WeakMap<object, { count: number; group: MarkdownDisplayToken }>();

function buildMarkdownDisplayTokensStable(
	tokenList: any[] = [],
	group: boolean
): MarkdownDisplayToken[] {
	const displayTokens: MarkdownDisplayToken[] = [];
	let detailGroup: any[] = [];
	let detailGroupStartIndex = 0;

	const flushDetailGroup = () => {
		if (detailGroup.length > 1) {
			const first = detailGroup[0];
			const cached = detailGroupCache.get(first);
			if (cached && cached.count === detailGroup.length) {
				displayTokens.push(cached.group);
			} else {
				const groupToken: MarkdownDisplayToken = {
					type: 'detail_group',
					id: `detail-group-${detailGroupStartIndex}`,
					items: [...detailGroup]
				};
				detailGroupCache.set(first, { count: detailGroup.length, group: groupToken });
				displayTokens.push(groupToken);
			}
		} else if (detailGroup.length === 1) {
			// A lone groupable detail keeps its own top-level rendering.
			const token = detailGroup[0];
			const cached = loneDetailCache.get(token);
			if (cached && cached.index === detailGroupStartIndex) {
				displayTokens.push(cached.wrapper);
			} else {
				const wrapper = { ...token, id: `detail-${detailGroupStartIndex}` };
				loneDetailCache.set(token, { index: detailGroupStartIndex, wrapper });
				displayTokens.push(wrapper);
			}
		}

		detailGroup = [];
	};

	tokenList.forEach((token, index) => {
		if (
			token?.type === 'details' &&
			token?.attributes?.type === 'tool_calls' &&
			token?.attributes?.hidden === 'true' &&
			!['pending', 'queued', 'requires_approval'].includes(token?.attributes?.status ?? '')
		) {
			return;
		}
		if (isGroupableDetailToken(token)) {
			if (detailGroup.length === 0) {
				detailGroupStartIndex = index;
			}
			detailGroup.push(token);
			return;
		}

		flushDetailGroup();
		const cached = plainWrapperCache.get(token);
		if (cached && cached.index === index) {
			displayTokens.push(cached.wrapper);
		} else {
			const wrapper = { ...token, id: `md-${index}` };
			plainWrapperCache.set(token, { index, wrapper });
			displayTokens.push(wrapper);
		}
	});

	flushDetailGroup();

	return foldProcessRun(displayTokens, group);
}

/**
 * Pure post-pass over the compiled tokens: the run spans everything up to
 * and including the last detail token, and folds only when the final answer
 * remains after it and the run holds a non-reasoning detail.
 */
function foldProcessRun(
	displayTokens: MarkdownDisplayToken[],
	group: boolean
): MarkdownDisplayToken[] {
	if (!group) {
		return displayTokens;
	}

	let lastDetailIndex = -1;
	displayTokens.forEach((token, index) => {
		if (isDetailToken(token)) {
			lastDetailIndex = index;
		}
	});
	if (lastDetailIndex < 0 || lastDetailIndex === displayTokens.length - 1) {
		return displayTokens;
	}

	const run = displayTokens.slice(0, lastDetailIndex + 1);
	if (!run.some(isNonReasoningDetailToken)) {
		return displayTokens;
	}

	return [
		{
			type: 'process_group',
			// Tie the id to the run's first member for stable re-folds.
			id: `process-group-${run[0].id}`,
			items: run
		},
		...displayTokens.slice(lastDetailIndex + 1)
	];
}
