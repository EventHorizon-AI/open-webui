<script lang="ts">
	import ArrowTurnDownRight from '$lib/components/icons/ArrowTurnDownRight.svelte';
	import { onMount, tick, getContext } from 'svelte';

	const i18n = getContext('i18n');

	export let followUps: string[] = [];
	export let onClick: (followUp: string) => void = () => {};
</script>

<div class="mt-4">
	<div class="text-sm font-normal text-base-500 dark:text-base-400">
		{$i18n.t('Follow up')}
	</div>

	<div class="flex flex-col text-left gap-1 mt-1.5">
		{#each followUps as followUp, idx (idx)}
			<button
				class=" mr-2 py-1 bg-transparent text-left text-sm flex items-center gap-2 px-1.5 text-base-400 dark:text-base-500 hover:text-base-600 dark:hover:text-base-300 transition cursor-pointer w-full"
				on:click={() => onClick(followUp)}
				aria-label={$i18n.t('Follow up: {{question}}', { question: followUp })}
			>
				<ArrowTurnDownRight className="size-3.5" />

				<div class="line-clamp-1">
					{followUp}
				</div>
			</button>

			{#if idx < followUps.length - 1}
				<hr class="border-base-50 dark:border-base-850/30" />
			{/if}
		{/each}
	</div>
</div>
