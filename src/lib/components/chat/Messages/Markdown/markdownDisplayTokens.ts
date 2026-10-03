export const GROUPABLE_DETAIL_TYPES = new Set(['tool_calls', 'reasoning', 'code_interpreter']);

export type MarkdownDisplayToken = {
	type: string;
	id?: string;
	items?: any[];
	[key: string]: any;
};

export const isGroupableDetailToken = (token: any): boolean =>
	token?.type === 'details' && GROUPABLE_DETAIL_TYPES.has(token?.attributes?.type ?? '');

/**
 * Compiles a flat list of marked block tokens into the tokens the markdown
 * renderer actually draws, folding runs of groupable `<details>` blocks (and the
 * prose narrated around them) into a single `process_group` token.
 *
 * This mirrors `buildOutputDisplayItems` in structuredOutput.ts: a run becomes a
 * process group only when it holds at least one non-reasoning detail (a tool
 * call, code interpreter, …); a run of reasoning alone stays flat. Content after
 * the last groupable detail is the final answer and stays top level.
 *
 * `group` mirrors the message lifecycle: while a reply is still streaming the
 * caller passes `false`, so the run renders the way it always did (narrated
 * content inline, consecutive details folded into a plain `detail_group`) and
 * only collapses into a process group once the message is done.
 */
export function buildMarkdownDisplayTokens(
	tokenList: any[] = [],
	group = true
): MarkdownDisplayToken[] {
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

	// Emit whatever has accumulated. Only a run that holds at least one
	// non-reasoning detail (a tool call, code interpreter, …) becomes a process
	// group; a run of reasoning alone stays flat. When a run does fold, the whole
	// run — reasoning included — goes into the group. While the message is still
	// streaming everything stays flat.
	const flushProcess = () => {
		flushDetailGroup();
		if (processItems.length === 0) {
			return;
		}

		if (!group) {
			displayTokens.push(...processItems);
			processItems = [];
			return;
		}

		const isNonReasoningDetail = (token: MarkdownDisplayToken): boolean =>
			token?.type === 'detail_group'
				? (token.items ?? []).some((item: any) => item?.attributes?.type !== 'reasoning')
				: isGroupableDetailToken(token) && token?.attributes?.type !== 'reasoning';

		if (processItems.some(isNonReasoningDetail)) {
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

		if (group && index < lastGroupableIndex) {
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
