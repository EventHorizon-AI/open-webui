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

<Collapsible {title} open={resolvedOpen} {attributes} {messageDone} {className} {buttonClassName}>
	<div class="mb-1.5" slot="content">
		<div class="markdown-prose reasoning-prose">
			<blockquote dir="auto">
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
			</blockquote>
		</div>
	</div>
</Collapsible>
