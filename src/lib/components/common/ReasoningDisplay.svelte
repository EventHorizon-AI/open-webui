<script lang="ts">
	import { getContext } from 'svelte';
	const i18n = getContext<typeof import('$lib/i18n').default>('i18n');

	import { settings } from '$lib/stores';

	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import Markdown from '$lib/components/chat/Messages/Markdown.svelte';

	export let id = '';
	export let title = null;
	export let attributes: any = null;
	export let content = '';

	export let open: boolean | undefined = undefined;
	export let messageDone = false;
	export let className = 'w-full';
	export let buttonClassName = '';

	export let chatId = '';
	export let messageId = '';
	export let done = true;
	export let save = false;
	export let preview = false;
	export let compactPreview = false;
	export let editCodeBlock = true;
	export let topPadding = false;
	export let sourceIds: any[] = [];

	export let onSourceClick: any = () => {};
	export let onTaskClick: any = () => {};
	export let onToolCallResolved: any = () => {};
	export let onSave: any = () => {};
	export let onUpdate: any = () => {};
	export let onPreview: any = () => {};

	// "Show reasoning summary only" turns the block into a plain, non-interactive
	// status line while the reasoning is streaming: no Collapsible, no toggle,
	// just the streaming preview text.
	$: reasoningPreviewOnly = $settings?.reasoningPreviewOnly ?? false;

	// "Show reasoning after completion" (only meaningful with the summary option)
	// keeps the finished reasoning in the message: once it is done the block falls
	// back to the regular, expandable Collapsible instead of leaving nothing behind.
	$: showAfterCompletion =
		reasoningPreviewOnly && ($settings?.keepReasoningAfterCompletion ?? false);

	// The reasoning is still streaming (summary mode): a finished reasoning is
	// signalled either by the block's own `done` flag or by the enclosing message
	// being done. While streaming, the summary line replaces the Collapsible
	// regardless of `showAfterCompletion`.
	$: reasoningStreaming =
		reasoningPreviewOnly && !done && !messageDone && attributes?.done !== 'true';

	$: resolvedOpen = open ?? $settings?.expandDetails ?? false;

	// Reasoning is stored with a blockquote marker on every line (legacy) or raw
	// (structured output). Strip any marker here so the component owns the quote
	// and content that already contains `>` lines is not double-quoted.
	const stripQuoteMarker = (line: string) =>
		line.startsWith('> ') ? line.slice(2) : line.startsWith('>') ? line.slice(1) : line;

	$: markdownContent = (content ?? '').split('\n').map(stripQuoteMarker).join('\n');
</script>

{#if reasoningPreviewOnly && reasoningStreaming}
	<!-- Summary only: a plain, non-interactive status line while streaming; falls
	     back to a "Thinking..." placeholder before the first preview line is
	     available, and is hidden entirely once the reasoning is done. -->
	<div class="{className} {buttonClassName} block select-none text-start" aria-hidden="false">
		<span class="block w-full truncate shimmer">{title || $i18n.t('Thinking...')}</span>
	</div>
{:else if !reasoningPreviewOnly || (!reasoningStreaming && showAfterCompletion)}
	<!-- Regular Collapsible path: the original behaviour, also used once the
	     reasoning is done when "show reasoning after completion" is on. -->
	<Collapsible
		{title}
		open={resolvedOpen}
		{attributes}
		{messageDone}
		{className}
		buttonClassName={`${buttonClassName} reasoning-detail-toggle`}
	>
		<div slot="content">
			<!-- Same thin rule as a markdown-prose blockquote, without the semantic <blockquote> element -->
			<div
				class="markdown-prose reasoning-prose border-s-2 border-s-gray-100 ps-[1em] dark:border-gray-800"
				dir="auto"
			>
				<Markdown
					{id}
					{chatId}
					{messageId}
					content={markdownContent}
					{done}
					{save}
					{preview}
					{compactPreview}
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
		</div>
	</Collapsible>
{:else}
	<!-- Summary only, finished and "show reasoning after completion" off:
	     nothing is left to render. -->
{/if}
