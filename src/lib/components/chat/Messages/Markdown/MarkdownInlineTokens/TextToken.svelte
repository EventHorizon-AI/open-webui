<script lang="ts">
	import { settings } from '$lib/stores';
	import { isWhitespaceSegment, createStreamingSegmenter } from '$lib/utils/streamingText';

	export let token;
	export let done = true;

	// Per-token state: the streaming fade-in only re-segments the growing tail
	// of this token (see createStreamingSegmenter) instead of the whole text.
	const segmenter = createStreamingSegmenter();

	$: raw = token?.raw ?? '';
	$: fadeStreaming = !done && ($settings?.chatFadeStreamingText ?? true);
	$: segments = fadeStreaming ? segmenter(raw) : null;
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
