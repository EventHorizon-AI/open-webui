<script lang="ts">
	import { settings } from '$lib/stores';

	import StructuredDisplayItem from './StructuredDisplayItem.svelte';
	import {
		buildOutputDisplayItems,
		type OutputDisplayItem,
		type OutputItem
	} from './structuredOutput';

	export let id = '';
	export let chatId = '';
	export let messageId = '';
	export let output: OutputItem[] = [];
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

	$: displayItems = buildOutputDisplayItems(
		output,
		$settings?.terminalFileDisplay === 'inline'
	) as OutputDisplayItem[];
</script>

{#each displayItems as displayItem, displayIndex (displayItem.id)}
	<StructuredDisplayItem
		{id}
		{chatId}
		{messageId}
		{displayItem}
		isLast={displayIndex === displayItems.length - 1}
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
