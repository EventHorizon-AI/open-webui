export const GROUPABLE_DETAIL_TYPES = new Set(['tool_calls', 'reasoning', 'code_interpreter']);

export type MarkdownDisplayToken = {
	type: string;
	id?: string;
	items?: any[];
	[key: string]: any;
};

export const isGroupableDetailToken = (token: any): boolean =>
	token?.type === 'details' && GROUPABLE_DETAIL_TYPES.has(token?.attributes?.type ?? '');

const isDetailDisplayToken = (token: MarkdownDisplayToken): boolean =>
	token?.type === 'detail_group' || isGroupableDetailToken(token);

/**
 * Compiles a flat list of marked block tokens into the tokens the markdown
 * renderer actually draws, folding runs of groupable `<details>` blocks (and the
 * prose narrated around them) into a single `process_group` token.
 *
 * This mirrors `buildOutputDisplayItems` in structuredOutput.ts: a run that holds
 * a detail group (two or more consecutive groupable details) always becomes a
 * process group, so does a run mixing narrated content with any detail; a lone
 * groupable detail stays flat. Content after the last groupable detail is the
 * final answer and stays top level.
 */
export function buildMarkdownDisplayTokens(tokenList: any[] = []): MarkdownDisplayToken[] {
	const displayTokens: MarkdownDisplayToken[] = [];
	let processItems: MarkdownDisplayToken[] = [];
	let detailGroup: any[] = [];
	let detailGroupStartIndex = 0;

	// A content token is only a final answer when no groupable detail can still
	// follow it. Any groupable detail later in the list means the content was
	// narrated on the way to a tool step, so it belongs in the process group.
	const lastGroupableIndex = tokenList.reduce(
		(last: number, token: any, index: number) => (isGroupableDetailToken(token) ? index : last),
		-1
	);

	const flushDetailGroup = () => {
		if (detailGroup.length > 1) {
			processItems.push({
				type: 'detail_group',
				id: `detail-group-${detailGroupStartIndex}`,
				items: [...detailGroup]
			});
		} else if (detailGroup.length === 1) {
			// A lone groupable detail keeps its own top-level rendering.
			processItems.push({ ...detailGroup[0], id: `detail-${detailGroupStartIndex}` });
		}

		detailGroup = [];
	};

	// Emit whatever has accumulated. A run that contains a detail group always
	// becomes a process group, even when no content was narrated around it; so
	// does a run mixing narrated content with any details. A lone detail stays
	// flat.
	const flushProcess = () => {
		flushDetailGroup();
		if (processItems.length === 0) {
			return;
		}

		const hasContent = processItems.some((item) => !isDetailDisplayToken(item));
		const hasDetailGroup = processItems.some((item) => item.type === 'detail_group');
		const hasAnyDetail = processItems.some(isDetailDisplayToken);

		if (hasDetailGroup || (hasAnyDetail && hasContent)) {
			// Tie the id to the first member so it survives reclassification while
			// streaming (a trailing message becoming narration must not remount it).
			displayTokens.push({
				type: 'process_group',
				id: `process-group-${processItems[0].id ?? detailGroupStartIndex}`,
				items: [...processItems]
			});
		} else {
			displayTokens.push(...processItems);
		}
		processItems = [];
	};

	tokenList.forEach((token, index) => {
		if (isGroupableDetailToken(token)) {
			if (detailGroup.length === 0) {
				detailGroupStartIndex = index;
			}
			detailGroup.push(token);
			return;
		}

		if (index < lastGroupableIndex) {
			// Narrated while a later tool step can still appear.
			flushDetailGroup();
			processItems.push({ ...token, id: `md-${index}` });
		} else {
			flushProcess();
			displayTokens.push({ ...token, id: `md-${index}` });
		}
	});

	flushProcess();

	return displayTokens;
}
