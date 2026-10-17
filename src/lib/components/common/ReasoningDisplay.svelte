<script lang="ts">
	import { getContext } from 'svelte';
	const i18n = getContext<typeof import('$lib/i18n').default>('i18n');

	import { settings } from '$lib/stores';

	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import Markdown from '$lib/components/chat/Messages/Markdown.svelte';
	import {
		deriveReasoningSummaries,
		isReasoningSummaryMarkdown,
		type ReasoningSummary
	} from './reasoningSummary';

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

	// The last title already present in summarised text. While the reasoning is
	// still streaming, a title only counts once its block has closed (a blank
	// line follows it); a title in the trailing paragraph could still change.
	const lastSummaryTitle = (text: string, incomplete: boolean) => {
		const lines = text.split('\n');
		for (let i = lines.length - 2; i >= 0; i--) {
			const title = /^\s*\*\*(.+?)\*\*\s*$/.exec(lines[i]);
			if (!title) {
				continue;
			}
			if (incomplete) {
				const hasClosed = lines.some((line, index) => index > i && line.trim() === '');
				if (!hasClosed) {
					continue;
				}
			}
			// Titles rendered by the summary builder escape markdown markers;
			// the status line shows the title as plain text.
			return title[1].trim().replace(/\\([*_`~\\])/g, '$1');
		}
		return '';
	};

	$: markdownContent = (content ?? '').split('\n').map(stripQuoteMarker).join('\n');

	// Text that already carries summary markdown (`**{title}**` followed by its
	// body) renders as written: running it through the builder again would cut
	// the existing summaries apart and derive titles they already have.
	$: alreadySummarized = isReasoningSummaryMarkdown(markdownContent);

	// The body renders as reasoning summaries (see buildReasoningSummary): a
	// summary is a block cut at the next blank line once it has reached
	// REASONING_SUMMARY_TOKEN_TARGET tokens and is shown only once complete, so
	// it never grows character by character while the reasoning streams. Each
	// summary carries a derived title and its body as separate fields; this
	// template renders the title as a bold lead paragraph and the body as
	// markdown. The trailing summary is still being written until the reasoning
	// itself is done — its owning block signals that through `attributes.done`,
	// or the enclosing message through `done` / `messageDone`. The builder also
	// holds the last titled block until the next block rules out a merge, so a
	// returned summary is never changed later.
	//
	// The derivation is incremental: a block's title and body are computed once,
	// when that block closes (or when the reasoning finishes). A tick that closes
	// no block returns the same array instance, and assigning it again would
	// invalidate every summary subtree, so the list is only replaced on change.
	// Text that already carries summaries is rebuilt from its body, so the body
	// is its identity check; both checks settle on the second pass.
	let reasoningSummaries: ReasoningSummary[] = [];
	$: {
		const nextSummaries = alreadySummarized
			? [{ title: '', body: markdownContent, truncated: false }]
			: deriveReasoningSummaries(id, markdownContent, !reasoningIncomplete);
		const unchanged = alreadySummarized
			? reasoningSummaries.length === 1 && reasoningSummaries[0].body === markdownContent
			: nextSummaries === reasoningSummaries;
		if (!unchanged) {
			reasoningSummaries = nextSummaries;
		}
	}

	// The streaming status line only shows a title from a finalized summary:
	// while a block waits for the next block's merge decision, its title is not
	// shown. Text that is already summarised shows its own last title instead
	// of deriving another one.
	$: previewTitle = alreadySummarized
		? lastSummaryTitle(markdownContent, reasoningIncomplete)
		: ([...reasoningSummaries].reverse().find((summary) => summary.title)?.title ?? '');
</script>

{#if reasoningPreviewOnly && reasoningStreaming}
	<!-- Summary only: a plain, non-interactive status line while streaming; falls
	     back to a "Thinking..." placeholder before the first preview line is
	     available, and is hidden entirely once the reasoning is done. -->
	<div class="{className} {buttonClassName} block select-none text-start" aria-hidden="false">
		<span class="block w-full truncate shimmer">{previewTitle || $i18n.t('Thinking...')}</span>
	</div>
{:else if !reasoningPreviewOnly || (!reasoningStreaming && showAfterCompletion)}
	{#if reasoningIncomplete && reasoningSummaries.length === 0}
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
					{#each reasoningSummaries as summary, summaryIndex (summaryIndex)}
						<!-- The wrapper owns the gap between blocks; inside a block the
						     title/body spacing comes from `.reasoning-title` /
						     `.reasoning-body` in app.css. -->
						<div class="reasoning-block">
							{#if alreadySummarized}
								<!-- Stored text is already rendered summary markdown (a bold
								     title, possibly lists or code), so it keeps the Markdown
								     path: parsing it here renders it as written. -->
								<Markdown
									id={`${id}-block-${summaryIndex}`}
									{chatId}
									{messageId}
									content={summary.body}
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
							{:else}
								<!-- Our own summaries carry a plain-text title and a single-line,
								     markup-free body (stripBodyMarkdown collapsed it), so plain
								     elements render them: no markdown misparse on an unclosed
								     marker and no parser pass. Svelte escapes interpolated text,
								     so there is no HTML injection surface. -->
								{#if summary.title}
									<p class="reasoning-title font-medium text-gray-700 dark:text-gray-300">
										{summary.title}
									</p>
								{/if}
								{#if summary.body}
									<p class="reasoning-body">{summary.body}</p>
								{/if}
							{/if}
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
