<script lang="ts">
	import { getContext } from 'svelte';
	const i18n = getContext<typeof import('$lib/i18n').default>('i18n');

	import { settings } from '$lib/stores';

	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import Markdown from '$lib/components/chat/Messages/Markdown.svelte';
	import { buildReasoningBlocks, deriveReasoningPreview } from './reasoningBlocks';

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

	// A finished reasoning is signalled either by the block's own `done` flag or
	// by the enclosing message being done; until then the trailing block is still
	// being written.
	$: reasoningIncomplete = !done && !messageDone && attributes?.done !== 'true';

	// Summary mode: while streaming, the plain status line replaces the
	// Collapsible regardless of `showAfterCompletion`.
	$: reasoningStreaming = reasoningPreviewOnly && reasoningIncomplete;

	$: resolvedOpen = open ?? $settings?.expandDetails ?? false;

	// Reasoning is stored with a blockquote marker on every line (legacy) or raw
	// (structured output). Strip any marker here so the component owns the quote
	// and content that already contains `>` lines is not double-quoted.
	const stripQuoteMarker = (line: string) =>
		line.startsWith('> ') ? line.slice(2) : line.startsWith('>') ? line.slice(1) : line;

	$: markdownContent = (content ?? '').split('\n').map(stripQuoteMarker).join('\n');

	// The body renders as display blocks (see buildReasoningBlocks): a block is
	// cut at the next blank line once it has reached REASONING_BLOCK_TOKEN_TARGET
	// tokens and is shown only once complete, so it never grows character by
	// character while the reasoning streams. Each block carries a title derived
	// from its own text (`**{title}**` followed by the remaining text). The
	// trailing block is still being written until the reasoning itself is done —
	// its owning block signals that through `attributes.done`, or the enclosing
	// message through `done` / `messageDone`.
	$: reasoningBlocks = buildReasoningBlocks(markdownContent, {
		streaming: reasoningIncomplete
	});

	// The streaming status line shows the title of the last fully generated block
	// (see deriveReasoningPreview), so it never shows a title of a block that is
	// still being written.
	$: previewTitle = deriveReasoningPreview(id, markdownContent);
</script>

{#if reasoningPreviewOnly && reasoningStreaming}
	<!-- Summary only: a plain, non-interactive status line while streaming; falls
	     back to a "Thinking..." placeholder before the first preview line is
	     available, and is hidden entirely once the reasoning is done. -->
	<div class="{className} {buttonClassName} block select-none text-start" aria-hidden="false">
		<span class="block w-full truncate shimmer">{previewTitle || $i18n.t('Thinking...')}</span>
	</div>
{:else if !reasoningPreviewOnly || (!reasoningStreaming && showAfterCompletion)}
	{#if reasoningIncomplete && reasoningBlocks.length === 0}
		<!-- No complete block yet: keep the same plain, non-interactive status
		     line as summary mode, instead of a Collapsible that would expand to
		     nothing. -->
		<div class="{className} {buttonClassName} block select-none text-start" aria-hidden="false">
			<span class="block w-full truncate shimmer">{previewTitle || $i18n.t('Thinking...')}</span>
		</div>
	{:else}
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
					{#each reasoningBlocks as block, blockIndex (blockIndex)}
						<!-- One stable Markdown instance per completed block: earlier blocks
						     keep their content, so only the newly completed block is parsed.
						     The wrapper owns the gap between blocks; elements inside a block
						     (a title paragraph followed by a list, say) keep prose rhythm. -->
						<div class="reasoning-block">
							<Markdown
								id={`${id}-block-${blockIndex}`}
								{chatId}
								{messageId}
								content={block.text}
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
					{/each}
				</div>
			</div>
		</Collapsible>
	{/if}
{:else}
	<!-- Summary only, finished and "show reasoning after completion" off:
	     nothing is left to render. -->
{/if}
