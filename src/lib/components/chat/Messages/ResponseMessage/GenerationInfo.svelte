<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import {
		buildGenerationInfo,
		formatRawGenerationInfo,
		type GenerationInfoSection,
		type GenerationInfoRow
	} from '$lib/utils/generationInfo';

	const i18n = getContext<Writable<i18nType>>('i18n');

	export let usage: unknown = null;
	export let compact = true;
	export let locale: string | undefined = undefined;

	let sections: GenerationInfoSection[] = [];
	let sectionLabels: Record<GenerationInfoSection['key'], string>;
	let fieldLabels: Record<string, string>;

	$: sections = usage && compact ? (buildGenerationInfo(usage, { locale }) ?? []) : [];
	$: rawUsage = usage && !compact ? formatRawGenerationInfo(usage) : '';

	// Labels are declared here as literals so translation tooling can extract the keys.
	$: sectionLabels = {
		speed: $i18n.t('Speed'),
		tokens: $i18n.t('Tokens'),
		time: $i18n.t('Time'),
		cost: $i18n.t('Cost'),
		other: $i18n.t('Other')
	};

	$: fieldLabels = {
		responseSpeed: $i18n.t('Response speed'),
		promptSpeed: $i18n.t('Prompt speed'),
		inputTokens: $i18n.t('Input tokens'),
		cachedInputTokens: $i18n.t('Cached input tokens'),
		cacheWriteTokens: $i18n.t('Cache write tokens'),
		outputTokens: $i18n.t('Output tokens'),
		reasoningTokens: $i18n.t('Reasoning tokens'),
		audioTokens: $i18n.t('Audio tokens'),
		acceptedPredictionTokens: $i18n.t('Accepted prediction tokens'),
		rejectedPredictionTokens: $i18n.t('Rejected prediction tokens'),
		totalTokens: $i18n.t('Total tokens'),
		totalTime: $i18n.t('Total time'),
		modelLoad: $i18n.t('Model load'),
		promptProcessing: $i18n.t('Prompt processing'),
		responseGeneration: $i18n.t('Response generation'),
		cost: $i18n.t('Cost'),
		totalCost: $i18n.t('Total cost'),
		inputCost: $i18n.t('Input cost'),
		outputCost: $i18n.t('Output cost'),
		promptCost: $i18n.t('Prompt cost'),
		completionCost: $i18n.t('Completion cost')
	};

	$: lastCallLabel = $i18n.t('last call');
	$: tokensPerSecondLabel = $i18n.t('tokens/s');

	const fieldLabel = (row: GenerationInfoRow): string =>
		fieldLabels[row.key] ?? row.label ?? row.key;
</script>

{#if compact}
	<div class="flex min-w-56 flex-col gap-2.5 py-0.5 text-left">
		{#each sections as section}
			<div class="flex flex-col gap-1">
				<div class="text-[0.625rem] font-semibold tracking-wider text-gray-400 uppercase">
					{sectionLabels[section.key]}{section.lastCall ? ` (${lastCallLabel})` : ''}
				</div>
				<div class="flex flex-col gap-0.5">
					{#each section.rows as row}
						<div class="flex items-baseline justify-between gap-6">
							<span class="shrink-0 text-gray-400">{fieldLabel(row)}</span>
							<span class="min-w-0 text-right font-medium break-words">
								{row.value}{row.unit === 'tokensPerSecond' ? ` ${tokensPerSecondLabel}` : ''}
							</span>
						</div>
					{/each}
				</div>
			</div>
		{/each}
	</div>
{:else}
	<pre>{rawUsage}</pre>
{/if}
