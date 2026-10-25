<script lang="ts">
	import { getContext } from 'svelte';
	import Collapsible from '$lib/components/common/Collapsible.svelte';

	const i18n = getContext<typeof import('$lib/i18n').default>('i18n');

	export let summary = '';
	export let status: 'in_progress' | { error: string } | undefined = undefined;
	export let compactPreview = false;

	$: rowClass = `flex w-full min-w-0 items-center gap-1.5 pt-0.5 pb-0.5 ${
		compactPreview ? 'text-xs' : 'text-[0.9375rem]'
	} text-gray-400 dark:text-gray-500`;

	// Shared by the static (non-Collapsible) rows: both sides of the label are
	// dashed dividers that recolor with the row text via border-current.
	$: dashedRowClass = `flex w-full items-center gap-2 pt-0.5 pb-0.5 text-xs leading-5 text-gray-500 select-none before:flex-1 before:border-t before:border-dashed before:border-current before:opacity-25 after:flex-1 after:border-t after:border-dashed after:border-current after:opacity-25 dark:text-gray-400`;
</script>

{#if status === 'in_progress'}
	<!-- Same dashed divider row as the summary label. Unselectable: the label
	     lives only while streaming. -->
	<div role="status" class={dashedRowClass}>
		<span>{$i18n.t('Compacting context')}</span>
	</div>
{:else if status}
	<div role="status" class={rowClass}>
		<span>{status.error}</span>
	</div>
{:else if summary.trim()}
	<!-- Keep expanding the summary from selecting a different model's response. -->
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div on:click|stopPropagation>
		<Collapsible
			buttonClassName="w-full cursor-pointer pt-0.5 pb-0.5 outline-offset-4 transition-colors hover:text-gray-700 focus-visible:outline-2 focus-visible:outline-gray-400 dark:hover:text-gray-200"
		>
			<!-- Dashed dividers sit on both sides of the label; text-* on the row
			     recolors them too since they use border-current. -->
			<div
				class="flex w-full items-center gap-2 text-xs leading-5 text-gray-500 before:flex-1 before:border-t before:border-dashed before:border-current before:opacity-25 after:flex-1 after:border-t after:border-dashed after:border-current after:opacity-25 dark:text-gray-400"
			>
				<span class="min-w-0 px-2 text-center">{$i18n.t('Context compacted')}</span>
			</div>

			<div
				slot="content"
				role="region"
				aria-label={$i18n.t('Compaction summary')}
				class="my-1.5 max-h-80 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-5 text-gray-600 dark:text-gray-300"
			>
				{summary}
			</div>
		</Collapsible>
	</div>
{:else}
	<!-- Static divider without a summary: same dashed look as the other rows,
	     but non-interactive and unselectable. -->
	<div class={dashedRowClass}>
		<span class="min-w-0 px-2 text-center">{$i18n.t('Context compacted')}</span>
	</div>
{/if}
