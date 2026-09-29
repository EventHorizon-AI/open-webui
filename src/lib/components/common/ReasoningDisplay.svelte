<script lang="ts">
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

	$: resolvedOpen = open ?? $settings?.expandDetails ?? false;

	// Reasoning is stored with a blockquote marker on every line (legacy) or raw
	// (structured output). Strip any marker here so the component owns the quote
	// and content that already contains `>` lines is not double-quoted.
	const stripQuoteMarker = (line: string) =>
		line.startsWith('> ') ? line.slice(2) : line.startsWith('>') ? line.slice(1) : line;

	$: markdownContent = (content ?? '').split('\n').map(stripQuoteMarker).join('\n');
</script>

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
