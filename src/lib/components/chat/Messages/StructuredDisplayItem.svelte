<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	const i18n = getContext<Writable<i18nType>>('i18n');

	import dayjs from '$lib/dayjs';
	import dayjsDuration from 'dayjs/plugin/duration';
	import dayjsRelativeTime from 'dayjs/plugin/relativeTime';

	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import ToolCallDisplay from '$lib/components/common/ToolCallDisplay.svelte';
	import ReasoningDisplay from '$lib/components/common/ReasoningDisplay.svelte';
	import TerminalOutputFile from './TerminalOutputFile.svelte';
	import { resolveChatMessageToolCall } from '$lib/apis/chats';
	import { settings } from '$lib/stores';
	import { toast } from 'svelte-sonner';

	import Markdown from './Markdown.svelte';
	import ConsecutiveDetailsGroup from './Markdown/ConsecutiveDetailsGroup.svelte';
	import {
		getDetailsDurationSeconds,
		getDetailCallCount,
		type OutputDetailToken,
		type OutputDisplayItem
	} from './structuredOutput';

	dayjs.extend(dayjsDuration);
	dayjs.extend(dayjsRelativeTime);

	export let id = '';
	export let chatId = '';
	export let messageId = '';
	export let displayItem: OutputDisplayItem;
	export let isLast = false;
	// True when this item is rendered inside a process group. The outer group
	// already surfaces tool embeds and approval buttons for everything it holds,
	// so nested items drop their own copy to avoid duplicates (and to keep them
	// reachable while the outer group is collapsed).
	export let nested = false;
	export let done = true;
	export let model = null;
	export let save = false;
	export let preview = false;
	export let compactPreview = false;
	export let renderMarkdown = true;
	export let editCodeBlock = true;
	export let topPadding = false;
	export let allowEmbeds = false;
	export let sourceIds: string[] = [];
	export let formatMessageContent: (content: string) => string = (content) => content;
	export let onSave: any = () => {};
	export let onSourceClick: any = () => {};
	export let onTaskClick: any = () => {};
	export let onUpdate: any = () => {};
	export let onPreview: any = () => {};
	export let onToolCallResolved: any = () => {};

	const getDetailTitle = (detailToken: OutputDetailToken): any => detailToken.summary;
	const getDetailAttributes = (detailToken: OutputDetailToken): any => detailToken.attributes;
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

	// Collect every detail token a process group holds so its header can summarise
	// the whole run (tool names, counts, running/error state) while the individual
	// detail groups stay nested inside it.
	const collectDetailTokens = (items: OutputDisplayItem[]): OutputDetailToken[] => {
		const tokens: OutputDetailToken[] = [];
		for (const item of items) {
			if (item.type === 'detail_group') {
				tokens.push(...item.tokens);
			} else if (item.type === 'detail_single') {
				tokens.push(item.token);
			} else if (item.type === 'process_group') {
				tokens.push(...collectDetailTokens(item.items));
			}
		}
		return tokens;
	};

	$: detailButtonClassName = `py-0.5 ${
		compactPreview ? 'text-xs' : 'text-[0.9375rem]'
	} text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition`;
	$: itemId = `${id}-${displayItem.id}`;
	$: processTokens =
		displayItem.type === 'process_group' ? collectDetailTokens(displayItem.items) : [];
	$: nestedAllowEmbeds = nested ? false : allowEmbeds;
	$: resolvable = !nested && !!chatId && !!messageId && save;

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

	// Only reasoning and code-interpreter items are timed, so the group's "time
	// taken" is the span between the first and last of those (see structuredOutput).
	$: processDuration =
		displayItem.type === 'process_group' ? getDetailsDurationSeconds(processTokens) : 0;

	// Tool calls and code-interpreter runs are not timed, so a run of only those
	// records no duration. Fall back to counting them for the group's "done"
	// summary; a process group always holds at least one, so the count is never
	// zero.
	$: processCallCount =
		displayItem.type === 'process_group' ? getDetailCallCount(processTokens) : 0;

	// Mirrors how a reasoning block's duration is rendered: seconds below a minute,
	// humanized above it. With no duration recorded it summarises how many calls
	// the run made instead.
	$: processDoneLabel =
		processDuration >= 60
			? $i18n.t('Completed in {{DURATION}}', {
					DURATION: dayjs.duration(processDuration, 'seconds').humanize()
				})
			: processDuration >= 1
				? $i18n.t('Completed in {{DURATION}} seconds', { DURATION: processDuration })
				: $i18n.t('Completed, called {{count}} times', { count: processCallCount });
</script>

{#if displayItem.type === 'message'}
	{#if renderMarkdown}
		<div class="markdown-prose">
			<Markdown
				id={itemId}
				{chatId}
				{messageId}
				content={formatMessageContent(displayItem.text)}
				{model}
				{save}
				{preview}
				{compactPreview}
				{done}
				{allowEmbeds}
				{editCodeBlock}
				{topPadding}
				{sourceIds}
				{onSourceClick}
				{onTaskClick}
				{onToolCallResolved}
				{onSave}
				{onUpdate}
				{onPreview}
			/>
		</div>
	{:else}
		<div class="whitespace-pre-wrap text-[0.9375rem]">{displayItem.text}</div>
	{/if}
{:else if displayItem.type === 'detail_group'}
	<ConsecutiveDetailsGroup
		id={itemId}
		tokens={displayItem.tokens}
		messageDone={done}
		groupOpen={!done && isLast}
		{compactPreview}
		allowEmbeds={nestedAllowEmbeds}
		{resolvable}
		{resolvingCallId}
		onResolve={resolveToolCall}
	>
		<div slot="content">
			{#each displayItem.tokens as detailToken, detailIndex}
				{#if detailToken.attributes?.type === 'tool_calls'}
					<ToolCallDisplay
						id={`${itemId}-${detailIndex}-tool-call`}
						attributes={detailToken.attributes}
						resultContent={detailToken.text}
						grouped={true}
						{resolvable}
						resolving={resolvingCallId === detailToken.attributes?.id}
						onResolve={(approved) => resolveToolCall(detailToken.attributes?.id ?? '', approved)}
						open={$settings?.expandDetails ?? false}
						className="w-full"
						buttonClassName={detailButtonClassName}
					/>
				{:else if detailToken.attributes?.type === 'reasoning'}
					<ReasoningDisplay
						id={`${itemId}-${detailIndex}-detail`}
						title={getDetailTitle(detailToken)}
						attributes={getDetailAttributes(detailToken)}
						content={detailToken.text}
						{chatId}
						{messageId}
						messageDone={done}
						{done}
						{save}
						{preview}
						{compactPreview}
						{editCodeBlock}
						{onToolCallResolved}
						className="w-full"
						buttonClassName={detailButtonClassName}
					/>
				{:else if detailToken.text?.length > 0}
					<Collapsible
						title={getDetailTitle(detailToken)}
						open={$settings?.expandDetails ?? false}
						attributes={getDetailAttributes(detailToken)}
						messageDone={done}
						className="w-full"
						buttonClassName={detailButtonClassName}
					>
						<div class="mb-1.5" slot="content">
							<div class="markdown-prose">
								<Markdown
									id={`${itemId}-${detailIndex}-detail`}
									{chatId}
									{messageId}
									content={detailToken.text}
									{done}
									{allowEmbeds}
									{save}
									{preview}
									{compactPreview}
									{editCodeBlock}
									{onToolCallResolved}
								/>
							</div>
						</div>
					</Collapsible>
				{:else}
					<Collapsible
						title={getDetailTitle(detailToken)}
						open={false}
						disabled={true}
						attributes={getDetailAttributes(detailToken)}
						messageDone={done}
						className="w-full"
						buttonClassName={detailButtonClassName}
					/>
				{/if}
			{/each}
		</div>
	</ConsecutiveDetailsGroup>
{:else if displayItem.type === 'process_group'}
	<!-- The process group behaves like a detail group, but its body holds the
	     nested detail groups and the content the model narrated around them. Only
	     built once the message is done, so the group never grows while it is shown. -->
	<ConsecutiveDetailsGroup
		id={itemId}
		tokens={processTokens}
		variant="reasoning"
		runningLabel={$i18n.t('Processing...')}
		doneLabel={processDoneLabel}
		messageDone={done}
		{compactPreview}
		{allowEmbeds}
		{resolvable}
		{resolvingCallId}
		onResolve={resolveToolCall}
	>
		<div slot="content">
			{#each displayItem.items as childItem (childItem.id)}
				<svelte:self
					id={itemId}
					{chatId}
					{messageId}
					displayItem={childItem}
					nested={true}
					isLast={isLast && childItem === displayItem.items[displayItem.items.length - 1]}
					{done}
					{model}
					{save}
					{preview}
					{compactPreview}
					{renderMarkdown}
					{editCodeBlock}
					{topPadding}
					{allowEmbeds}
					{sourceIds}
					{formatMessageContent}
					{onSave}
					{onSourceClick}
					{onTaskClick}
					{onUpdate}
					{onPreview}
					{onToolCallResolved}
				/>
			{/each}
		</div>
	</ConsecutiveDetailsGroup>
{:else if displayItem.type === 'file'}
	{#if displayItem.item?.displayed || $settings?.terminalFileDisplay === 'inline'}
		<TerminalOutputFile item={displayItem.item} {chatId} />
	{/if}
{:else}
	{@const detailToken = displayItem.token}
	{#if detailToken.attributes?.type === 'tool_calls'}
		<ToolCallDisplay
			id={`${itemId}-tool-call`}
			attributes={detailToken.attributes}
			resultContent={detailToken.text}
			allowEmbeds={nestedAllowEmbeds}
			{resolvable}
			resolving={resolvingCallId === detailToken.attributes?.id}
			onResolve={(approved) => resolveToolCall(detailToken.attributes?.id ?? '', approved)}
			open={$settings?.expandDetails ?? false}
			className="w-full"
			buttonClassName={detailButtonClassName}
		/>
	{:else if detailToken.attributes?.type === 'reasoning'}
		<ReasoningDisplay
			id={`${itemId}-detail`}
			title={getDetailTitle(detailToken)}
			attributes={getDetailAttributes(detailToken)}
			content={detailToken.text}
			{chatId}
			{messageId}
			messageDone={done}
			{done}
			{save}
			{preview}
			{compactPreview}
			{editCodeBlock}
			{onToolCallResolved}
			className="w-full"
			buttonClassName={detailButtonClassName}
		/>
	{:else if detailToken.text?.length > 0}
		<Collapsible
			title={getDetailTitle(detailToken)}
			open={$settings?.expandDetails ?? false}
			attributes={getDetailAttributes(detailToken)}
			messageDone={done}
			className="w-full space-y-2"
			buttonClassName={detailButtonClassName}
		>
			<div class="mb-1.5" slot="content">
				<div class="markdown-prose">
					<Markdown
						id={`${itemId}-detail`}
						{chatId}
						{messageId}
						content={detailToken.text}
						{done}
						{allowEmbeds}
						{save}
						{preview}
						{compactPreview}
						{editCodeBlock}
						{onToolCallResolved}
					/>
				</div>
			</div>
		</Collapsible>
	{:else}
		<Collapsible
			title={getDetailTitle(detailToken)}
			open={false}
			disabled={true}
			attributes={getDetailAttributes(detailToken)}
			messageDone={done}
			className="w-full space-y-2"
			buttonClassName={detailButtonClassName}
		/>
	{/if}
{/if}
