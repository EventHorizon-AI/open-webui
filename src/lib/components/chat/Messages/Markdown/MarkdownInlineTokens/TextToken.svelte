<script lang="ts">
	import { settings } from '$lib/stores';
	import { isWhitespaceSegment, segmentStreamingText } from '$lib/utils/streamingText';

	export let token;
	export let done = true;

	$: raw = token?.raw ?? '';
	$: fadeStreaming = !done && ($settings?.chatFadeStreamingText ?? true);
	$: segments = fadeStreaming ? segmentStreamingText(raw) : null;
</script>

{#if segments === null}
	{raw}
{:else}
	{#each segments as segment}
		{#if isWhitespaceSegment(segment)}
			{segment}
		{:else}
			<span class="fade-in-token">{segment}</span>
		{/if}
	{/each}
{/if}
