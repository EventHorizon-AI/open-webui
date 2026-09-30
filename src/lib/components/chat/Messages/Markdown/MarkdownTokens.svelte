<script lang="ts">
	import { decode } from 'html-entities';
	import { onMount, getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	const i18n = getContext<Writable<i18nType>>('i18n');

	import fileSaver from 'file-saver';
	const { saveAs } = fileSaver;

	import { marked, type Token } from 'marked';
	import { copyToClipboard, unescapeHtml } from '$lib/utils';
	import { resolveChatMessageToolCall } from '$lib/apis/chats';

	import dayjs from '$lib/dayjs';
	import dayjsDuration from 'dayjs/plugin/duration';
	import dayjsRelativeTime from 'dayjs/plugin/relativeTime';

	import { WEBUI_BASE_URL } from '$lib/constants';
	import { settings } from '$lib/stores';
	import { toast } from 'svelte-sonner';

	import CodeBlock from '$lib/components/chat/Messages/CodeBlock.svelte';
	import MarkdownInlineTokens from '$lib/components/chat/Messages/Markdown/MarkdownInlineTokens.svelte';
	import KatexRenderer from './KatexRenderer.svelte';
	import AlertRenderer, { alertComponent } from './AlertRenderer.svelte';
	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import ToolCallDisplay from '$lib/components/common/ToolCallDisplay.svelte';
	import ReasoningDisplay from '$lib/components/common/ReasoningDisplay.svelte';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import Download from '$lib/components/icons/Download.svelte';
	import ConsecutiveDetailsGroup from './ConsecutiveDetailsGroup.svelte';

	import HtmlToken from './HTMLToken.svelte';
	import Clipboard from '$lib/components/icons/Clipboard.svelte';
	import ColonFenceBlock from './ColonFenceBlock.svelte';
	import { buildMarkdownDisplayTokens, isGroupableDetailToken } from './markdownDisplayTokens';
	import { getDetailsDurationSeconds } from '../structuredOutput';

	dayjs.extend(dayjsDuration);
	dayjs.extend(dayjsRelativeTime);

	export let id: string;
	export let chatId = '';
	export let messageId = '';
	export let tokens: Token[];
	export let top = true;
	export let attributes = {};
	export let sourceIds = [];

	export let done = true;

	export let save = false;
	export let preview = false;
	export let compactPreview = false;

	export let paragraphTag = 'p';

	export let editCodeBlock = true;
	export let topPadding = false;
	export let allowEmbeds = false;

	export let onSave: Function = () => {};
	export let onUpdate: Function = () => {};
	export let onPreview: Function = () => {};

	export let onTaskClick: Function = () => {};
	export let onSourceClick: Function = () => {};
	export let onToolCallResolved: Function = () => {};

	const headerComponent = (depth: number) => {
		return 'h' + depth;
	};

	const getDetailTextContent = (token) => {
		return decode(token?.text || '')
			.replace(/<summary>.*?<\/summary>/gi, '')
			.trim();
	};

	let resolvingCallId = '';

	const resolveToolCall = async (callId: string, approved: boolean) => {
		if (!chatId || !messageId || !callId || resolvingCallId) {
			return;
		}

		resolvingCallId = callId;
		try {
			const res = await resolveChatMessageToolCall(
				localStorage.token,
				chatId,
				messageId,
				callId,
				approved ? 'approve' : 'reject'
			);
			onToolCallResolved(res);
		} catch (err) {
			toast.error(String(err));
		} finally {
			resolvingCallId = '';
		}
	};

	// Keep dayjs' duration humanization in the active UI language, the same way
	// Collapsible does for reasoning durations.
	const loadDayjsLocale = (locales: readonly string[] | undefined) => {
		if (!locales?.length) return;
		for (const locale of locales) {
			try {
				dayjs.locale(locale);
				break;
			} catch {
				// not bundled for dayjs; fall through to the next language
			}
		}
	};
	$: loadDayjsLocale($i18n?.languages);

	// Every groupable detail token a process group holds, so its header can
	// summarise the whole run and surface embeds / approval buttons.
	const getProcessTokens = (processToken: any) => {
		const detailTokens: any[] = [];
		for (const item of processToken?.items ?? []) {
			if (item?.type === 'detail_group') {
				detailTokens.push(...item.items);
			} else if (isGroupableDetailToken(item)) {
				detailTokens.push(item);
			}
		}
		return detailTokens;
	};

	// Mirrors how a reasoning block's duration is rendered: seconds below a
	// minute, humanized above it, and no duration at all when none was recorded.
	const getProcessDoneLabel = (processToken: any) => {
		const processDuration = getDetailsDurationSeconds(getProcessTokens(processToken));

		return processDuration >= 60
			? $i18n.t('Completed in {{DURATION}}', {
					DURATION: dayjs.duration(processDuration, 'seconds').humanize()
				})
			: processDuration >= 1
				? $i18n.t('Completed in {{DURATION}} seconds', { DURATION: processDuration })
				: $i18n.t('Analysis complete');
	};

	$: detailButtonClassName = `py-0.5 ${
		compactPreview ? 'text-xs' : 'text-[0.9375rem]'
	} text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition`;

	// Process grouping only happens once the message is done: while it is still
	// streaming the run renders flat (narrated content inline, consecutive
	// details folded into a plain detail group) instead of the process group.
	$: displayTokens = buildMarkdownDisplayTokens(tokens, done);
	$: singlePlainBlock =
		displayTokens.length === 1 &&
		(displayTokens[0]?.type === 'paragraph' || displayTokens[0]?.type === 'text');

	// A single very long paragraph is one block-level layout context, so any change to it
	// forces Chromium to lay out the whole paragraph again (O(content)) every frame,
	// which is what makes scrolling stutter. When its inline token list is large, split
	// it into several block-level chunks so only the growing chunk has to be laid out.
	// Measured in bench/svelte-forced-layout: ~4-9x less per-frame layout, at the cost of
	// a forced line break per boundary (~0.6-2% taller rendering at this chunk size).
	const INLINE_CHUNK_SIZE = 500;

	const getInlineChunks = (inlineTokens: Token[] | undefined) => {
		if (!inlineTokens || inlineTokens.length <= INLINE_CHUNK_SIZE) return null;

		const chunks: Token[][] = [];
		for (let i = 0; i < inlineTokens.length; i += INLINE_CHUNK_SIZE) {
			chunks.push(inlineTokens.slice(i, i + INLINE_CHUNK_SIZE));
		}
		return chunks;
	};

	const exportTableToCSVHandler = (token, tokenIdx = 0) => {
		console.log('Exporting table to CSV');

		// Extract header row text, decode HTML entities, and escape for CSV.
		const header = token.header.map(
			(headerCell) => `"${decode(headerCell.text).replace(/"/g, '""')}"`
		);

		// Create an array for rows that will hold the mapped cell text.
		const rows = token.rows.map((row) =>
			row.map((cell) => {
				// Map tokens into a single text
				const cellContent = cell.tokens.map((token) => token.text).join('');
				// Decode HTML entities and escape double quotes, wrap in double quotes
				return `"${decode(cellContent).replace(/"/g, '""')}"`;
			})
		);

		// Combine header and rows
		const csvData = [header, ...rows];

		// Join the rows using commas (,) as the separator and rows using newline (\n).
		const csvContent = csvData.map((row) => row.join(',')).join('\n');

		// Log rows and CSV content to ensure everything is correct.
		console.log(csvData);
		console.log(csvContent);

		// To handle Unicode characters, you need to prefix the data with a BOM:
		const bom = '\uFEFF'; // BOM for UTF-8

		// Create a new Blob prefixed with the BOM to ensure proper Unicode encoding.
		const blob = new Blob([bom + csvContent], { type: 'text/csv;charset=UTF-8' });

		// Use FileSaver.js's saveAs function to save the generated CSV file.
		saveAs(blob, `table-${id}-${tokenIdx}.csv`);
	};
</script>

<!-- {JSON.stringify(tokens)} -->
{#snippet tokenRenderer(token: any, tokenIdx: number, nested: boolean, rendererId: string)}
	{#if token.type === 'hr'}
		<hr class="border-gray-50 dark:border-gray-850/30" />
	{:else if token.type === 'heading'}
		<svelte:element this={headerComponent(token.depth)} dir="auto">
			<MarkdownInlineTokens
				id={`${rendererId}-${tokenIdx}-h`}
				tokens={token.tokens}
				{done}
				{sourceIds}
				{onSourceClick}
			/>
		</svelte:element>
	{:else if token.type === 'code'}
		{#if token.raw.includes('```')}
			<CodeBlock
				id={`${rendererId}-${tokenIdx}`}
				collapsed={$settings?.collapseCodeBlocks ?? false}
				{token}
				lang={token?.lang ?? ''}
				code={token?.text ?? ''}
				{attributes}
				{save}
				{preview}
				edit={editCodeBlock}
				stickyButtonsClassName={topPadding ? 'top-10' : 'top-0'}
				onSave={(value) => {
					onSave({
						raw: token.raw,
						oldContent: token.text,
						newContent: value
					});
				}}
				{onUpdate}
				{onPreview}
			/>
		{:else}
			{token.text}
		{/if}
	{:else if token.type === 'table'}
		<div class="relative w-full group mb-2">
			<div class="scrollbar-hidden relative overflow-x-auto max-w-full">
				<table
					class=" w-full text-sm text-start text-gray-500 dark:text-gray-400 max-w-full rounded-xl"
					dir="auto"
				>
					<thead class="text-xs text-gray-700 uppercase dark:text-gray-400 border-none">
						<tr class="">
							{#each token.header as header, headerIdx}
								<th
									scope="col"
									class="px-2.5! py-2! cursor-pointer border-b border-gray-100! dark:border-gray-800!"
									style={token.align[headerIdx] ? `text-align: ${token.align[headerIdx]}` : ''}
								>
									<div class="gap-1.5 text-start">
										<div class="shrink-0 break-normal">
											<MarkdownInlineTokens
												id={`${rendererId}-${tokenIdx}-header-${headerIdx}`}
												tokens={header.tokens}
												{done}
												{sourceIds}
												{onSourceClick}
											/>
										</div>
									</div>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each token.rows as row, rowIdx}
							<tr class="text-xs">
								{#each row ?? [] as cell, cellIdx}
									<td
										class="px-3! py-2! text-gray-900 dark:text-white w-max {token.rows.length -
											1 ===
										rowIdx
											? ''
											: 'border-b border-gray-50! dark:border-gray-850!'}"
										style={token.align[cellIdx] ? `text-align: ${token.align[cellIdx]}` : ''}
									>
										<div class="break-normal">
											<MarkdownInlineTokens
												id={`${rendererId}-${tokenIdx}-row-${rowIdx}-${cellIdx}`}
												tokens={cell.tokens}
												{done}
												{sourceIds}
												{onSourceClick}
											/>
										</div>
									</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
			</div>

			<div class=" absolute top-1 right-1.5 z-20 hover-reveal flex gap-0.5">
				<Tooltip content={$i18n.t('Copy')}>
					<button
						class="p-1 rounded-lg bg-transparent transition"
						on:click={(e) => {
							e.stopPropagation();
							copyToClipboard(token.raw.trim(), null, $settings?.copyFormatted ?? false);
						}}
					>
						<Clipboard className=" size-3.5" strokeWidth="1.5" />
					</button>
				</Tooltip>

				<Tooltip content={$i18n.t('Export to CSV')}>
					<button
						class="p-1 rounded-lg bg-transparent transition"
						on:click={(e) => {
							e.stopPropagation();
							exportTableToCSVHandler(token, tokenIdx);
						}}
					>
						<Download className=" size-3.5" strokeWidth="1.5" />
					</button>
				</Tooltip>
			</div>
		</div>
	{:else if token.type === 'blockquote'}
		{@const alert = alertComponent(token)}
		{#if alert}
			<AlertRenderer {token} {alert} {allowEmbeds} />
		{:else}
			<blockquote dir="auto">
				<svelte:self
					id={`${rendererId}-${tokenIdx}`}
					{chatId}
					{messageId}
					tokens={token.tokens}
					{done}
					{allowEmbeds}
					{save}
					{preview}
					{compactPreview}
					{editCodeBlock}
					{onTaskClick}
					{sourceIds}
					{onSourceClick}
					{onToolCallResolved}
				/>
			</blockquote>
		{/if}
	{:else if token.type === 'list'}
		{#if token.ordered}
			<ol start={token.start || 1} dir="auto">
				{#each token.items as item, itemIdx}
					<li class="text-start">
						{#if item?.task}
							<input
								class=" translate-y-[1px] -translate-x-1 flex-shrink-0"
								type="checkbox"
								checked={item.checked}
								on:change={(e) => {
									onTaskClick({
										id: id,
										token: token,
										tokenIdx: tokenIdx,
										item: item,
										itemIdx: itemIdx,
										checked: e.target.checked
									});
								}}
							/>
						{/if}

						<svelte:self
							id={`${rendererId}-${tokenIdx}-${itemIdx}`}
							{chatId}
							{messageId}
							tokens={item.tokens}
							top={token.loose}
							{done}
							{allowEmbeds}
							{save}
							{preview}
							{compactPreview}
							{editCodeBlock}
							{onTaskClick}
							{sourceIds}
							{onSourceClick}
						/>
					</li>
				{/each}
			</ol>
		{:else}
			<ul dir="auto" class="">
				{#each token.items as item, itemIdx}
					<li class="text-start {item?.task ? 'flex -translate-x-6.5 gap-3 ' : ''}">
						{#if item?.task}
							<input
								class="flex-shrink-0"
								type="checkbox"
								checked={item.checked}
								on:change={(e) => {
									onTaskClick({
										id: id,
										token: token,
										tokenIdx: tokenIdx,
										item: item,
										itemIdx: itemIdx,
										checked: e.target.checked
									});
								}}
							/>

							<div>
								<svelte:self
									id={`${rendererId}-${tokenIdx}-${itemIdx}`}
									{chatId}
									{messageId}
									tokens={item.tokens}
									top={token.loose}
									{done}
									{allowEmbeds}
									{save}
									{preview}
									{compactPreview}
									{editCodeBlock}
									{onTaskClick}
									{sourceIds}
									{onSourceClick}
								/>
							</div>
						{:else}
							<svelte:self
								id={`${rendererId}-${tokenIdx}-${itemIdx}`}
								{chatId}
								{messageId}
								tokens={item.tokens}
								top={token.loose}
								{done}
								{allowEmbeds}
								{save}
								{preview}
								{compactPreview}
								{editCodeBlock}
								{onTaskClick}
								{sourceIds}
								{onSourceClick}
							/>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	{:else if token.type === 'detail_group'}
		<ConsecutiveDetailsGroup
			id={`${rendererId}-${tokenIdx}-detail-group`}
			tokens={token.items}
			messageDone={done}
			groupOpen={!done && !nested && tokenIdx === displayTokens.length - 1}
			{compactPreview}
			allowEmbeds={nested ? false : allowEmbeds}
			resolvable={!nested && !!chatId && !!messageId && save}
			{resolvingCallId}
			onResolve={resolveToolCall}
		>
			<div slot="content">
				{#each token.items as detailToken, detailIdx}
					{@const textContent = getDetailTextContent(detailToken)}

					{#if detailToken?.attributes?.type === 'tool_calls'}
						<ToolCallDisplay
							id={`${rendererId}-${tokenIdx}-${detailIdx}-tc`}
							attributes={detailToken.attributes}
							resultContent={getDetailTextContent(detailToken)}
							grouped={true}
							resolvable={!nested && !!chatId && !!messageId && save}
							resolving={resolvingCallId === detailToken.attributes?.id}
							onResolve={(approved) => resolveToolCall(detailToken.attributes?.id ?? '', approved)}
							open={$settings?.expandDetails ?? false}
							className="w-full"
							buttonClassName={detailButtonClassName}
						/>
					{:else if detailToken?.attributes?.type === 'reasoning' && textContent.length > 0}
						<ReasoningDisplay
							id={`${rendererId}-${tokenIdx}-${detailIdx}-d`}
							title={detailToken.summary}
							attributes={detailToken?.attributes}
							content={decode(detailToken.text)}
							{chatId}
							{messageId}
							messageDone={done}
							{done}
							{save}
							{preview}
							{compactPreview}
							{editCodeBlock}
							{onTaskClick}
							{sourceIds}
							{onSourceClick}
							className="w-full"
							buttonClassName={detailButtonClassName}
						/>
					{:else if textContent.length > 0}
						<Collapsible
							title={detailToken.summary}
							open={$settings?.expandDetails ?? false}
							attributes={detailToken?.attributes}
							messageDone={done}
							className="w-full"
							buttonClassName={detailButtonClassName}
							dir="auto"
						>
							<div class="mb-1.5" slot="content">
								<svelte:self
									id={`${rendererId}-${tokenIdx}-${detailIdx}-d`}
									{chatId}
									{messageId}
									tokens={marked.lexer(decode(detailToken.text))}
									attributes={detailToken?.attributes}
									{done}
									{allowEmbeds}
									{save}
									{preview}
									{compactPreview}
									{editCodeBlock}
									{onTaskClick}
									{sourceIds}
									{onSourceClick}
								/>
							</div>
						</Collapsible>
					{:else}
						<Collapsible
							title={detailToken.summary}
							open={false}
							disabled={true}
							attributes={detailToken?.attributes}
							messageDone={done}
							className="w-full"
							buttonClassName={detailButtonClassName}
							dir="auto"
						/>
					{/if}
				{/each}
			</div>
		</ConsecutiveDetailsGroup>
	{:else if token.type === 'process_group'}
		<!-- A run of details plus the content narrated around it. Rendered like the
		     structured output path's process group: a reasoning-style header whose
		     body re-renders the run's child tokens. Only built once the message is
		     done, so the group never grows while it is shown. -->
		<ConsecutiveDetailsGroup
			id={`${rendererId}-${tokenIdx}-process-group`}
			tokens={getProcessTokens(token)}
			variant="reasoning"
			runningLabel={$i18n.t('Processing...')}
			doneLabel={getProcessDoneLabel(token)}
			messageDone={done}
			{compactPreview}
			allowEmbeds={nested ? false : allowEmbeds}
			resolvable={!nested && !!chatId && !!messageId && save}
			{resolvingCallId}
			onResolve={resolveToolCall}
		>
			<div slot="content">
				{#each token.items as childToken, childIdx (childToken.id ?? childIdx)}
					{@render tokenRenderer(childToken, childIdx, true, `${rendererId}-${tokenIdx}`)}
				{/each}
			</div>
		</ConsecutiveDetailsGroup>
	{:else if token.type === 'details'}
		{@const textContent = getDetailTextContent(token)}

		{#if token?.attributes?.type === 'tool_calls'}
			<!-- Tool calls have dedicated handling with ToolCallDisplay component -->
			<ToolCallDisplay
				id={`${rendererId}-${tokenIdx}-tc`}
				attributes={token.attributes}
				resultContent={getDetailTextContent(token)}
				allowEmbeds={nested ? false : allowEmbeds}
				resolvable={!nested && !!chatId && !!messageId && save}
				resolving={resolvingCallId === token.attributes?.id}
				onResolve={(approved) => resolveToolCall(token.attributes?.id ?? '', approved)}
				open={$settings?.expandDetails ?? false}
				className="w-full"
				buttonClassName={detailButtonClassName}
			/>
		{:else if token?.attributes?.type === 'reasoning' && textContent.length > 0}
			<ReasoningDisplay
				id={`${rendererId}-${tokenIdx}-d`}
				title={token.summary}
				attributes={token?.attributes}
				content={decode(token.text)}
				{chatId}
				{messageId}
				messageDone={done}
				{done}
				{save}
				{preview}
				{compactPreview}
				{editCodeBlock}
				{onTaskClick}
				{sourceIds}
				{onSourceClick}
				className="w-full"
				buttonClassName={detailButtonClassName}
			/>
		{:else if textContent.length > 0}
			<Collapsible
				title={token.summary}
				open={$settings?.expandDetails ?? false}
				attributes={token?.attributes}
				messageDone={done}
				className="w-full"
				buttonClassName={detailButtonClassName}
				dir="auto"
			>
				<div class="mt-2 mb-1.5" slot="content">
					<svelte:self
						id={`${rendererId}-${tokenIdx}-d`}
						{chatId}
						{messageId}
						tokens={marked.lexer(decode(token.text))}
						attributes={token?.attributes}
						{done}
						{allowEmbeds}
						{save}
						{preview}
						{compactPreview}
						{editCodeBlock}
						{onTaskClick}
						{sourceIds}
						{onSourceClick}
					/>
				</div>
			</Collapsible>
		{:else}
			<Collapsible
				title={token.summary}
				open={false}
				disabled={true}
				attributes={token?.attributes}
				messageDone={done}
				className="w-full space-y-2"
				buttonClassName={detailButtonClassName}
				dir="auto"
			/>
		{/if}
	{:else if token.type === 'html'}
		<HtmlToken {id} {token} {onSourceClick} />
	{:else if token.type === 'iframe'}
		<iframe
			src="{WEBUI_BASE_URL}/api/v1/files/{token.fileId}/content"
			title={token.fileId}
			width="100%"
			frameborder="0"
			on:load={(e) => {
				try {
					e.currentTarget.style.height =
						e.currentTarget.contentWindow.document.body.scrollHeight + 20 + 'px';
				} catch {}
			}}
		></iframe>
	{:else if token.type === 'paragraph'}
		{@const paragraphChunks = paragraphTag == 'span' ? null : getInlineChunks(token.tokens)}
		{#if paragraphTag == 'span'}
			<span dir="auto">
				<MarkdownInlineTokens
					id={`${rendererId}-${tokenIdx}-p`}
					tokens={token.tokens ?? []}
					{done}
					{sourceIds}
					{onSourceClick}
				/>
			</span>
		{:else if paragraphChunks}
			<div dir="auto" class="md-block-chunks {singlePlainBlock ? '!my-0' : 'mb-2'}">
				{#each paragraphChunks as chunk, chunkIdx (chunkIdx)}
					<div class="md-block">
						<MarkdownInlineTokens
							id={`${rendererId}-${tokenIdx}-p-${chunkIdx}`}
							tokens={chunk}
							{done}
							{sourceIds}
							{onSourceClick}
						/>
					</div>
				{/each}
			</div>
		{:else}
			<p dir="auto" class={singlePlainBlock ? '!my-0' : ''}>
				<MarkdownInlineTokens
					id={`${rendererId}-${tokenIdx}-p`}
					tokens={token.tokens ?? []}
					{done}
					{sourceIds}
					{onSourceClick}
				/>
			</p>
		{/if}
	{:else if token.type === 'text'}
		{@const textChunks = top && token.tokens ? getInlineChunks(token.tokens) : null}
		{#if top}
			{#if textChunks}
				<div class="md-block-chunks {singlePlainBlock ? '!my-0' : 'mb-2'}">
					{#each textChunks as chunk, chunkIdx (chunkIdx)}
						<div class="md-block">
							<MarkdownInlineTokens
								id={`${rendererId}-${tokenIdx}-t-${chunkIdx}`}
								tokens={chunk}
								{done}
								{sourceIds}
								{onSourceClick}
							/>
						</div>
					{/each}
				</div>
			{:else}
				<p class={singlePlainBlock ? '!my-0' : ''}>
					{#if token.tokens}
						<MarkdownInlineTokens
							id={`${rendererId}-${tokenIdx}-t`}
							tokens={token.tokens}
							{done}
							{sourceIds}
							{onSourceClick}
						/>
					{:else}
						{unescapeHtml(token.text)}
					{/if}
				</p>
			{/if}
		{:else if token.tokens}
			<MarkdownInlineTokens
				id={`${rendererId}-${tokenIdx}-p`}
				tokens={token.tokens ?? []}
				{done}
				{sourceIds}
				{onSourceClick}
			/>
		{:else}
			{unescapeHtml(token.text)}
		{/if}
	{:else if token.type === 'inlineKatex'}
		{#if token.text}
			<KatexRenderer content={token.text} displayMode={token?.displayMode ?? false} />
		{/if}
	{:else if token.type === 'blockKatex'}
		{#if token.text}
			<KatexRenderer content={token.text} displayMode={token?.displayMode ?? false} />
		{/if}
	{:else if token.type === 'colonFence'}
		<ColonFenceBlock
			id={`${rendererId}-${tokenIdx}`}
			{token}
			{tokenIdx}
			{done}
			{allowEmbeds}
			{editCodeBlock}
			{sourceIds}
			{onTaskClick}
			{onSourceClick}
		/>
	{:else if token.type === 'space'}
		<!-- skip -->
	{:else}
		{console.log('Unknown token', token)}
	{/if}
{/snippet}

{#each displayTokens as token, tokenIdx (token.id ?? tokenIdx)}
	{@render tokenRenderer(token, tokenIdx, false, id)}
{/each}
