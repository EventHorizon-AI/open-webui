<script lang="ts">
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { type Model, selectedModelVariants } from '$lib/stores';

	import Dropdown from '$lib/components/common/Dropdown.svelte';
	import DropdownMenu from '$lib/components/common/DropdownMenu.svelte';
	import Check from '$lib/components/icons/Check.svelte';

	const i18n: Writable<i18nType> = getContext('i18n');

	export let model: Model | null = null;
	export let disabled = false;
	export let triggerClassName =
		'items-center gap-1.5 rounded-lg px-1.5 py-1 text-[0.8125rem] font-normal text-gray-600 transition-colors duration-100 hover:bg-gray-50/40 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-800/40 dark:hover:text-gray-200';

	let show = false;

	$: options = [
		{ value: '', label: $i18n.t('Default') },
		...(model?.info?.meta?.variants ?? []).map((variant) => ({
			value: variant.id,
			label: variant.name || variant.id
		}))
	];
	$: selectedVariant = model ? ($selectedModelVariants[model.id] ?? '') : '';
	$: selectedLabel =
		options.find((option) => option.value === selectedVariant)?.label ?? $i18n.t('Default');

	const selectVariant = (variantId: string) => {
		if (!model) return;

		selectedModelVariants.update((selections) => ({
			...selections,
			[model.id]: variantId
		}));
		show = false;
	};
</script>

<Dropdown bind:show>
	<button
		type="button"
		class="focus-ring relative max-w-full text-left {disabled ? 'cursor-not-allowed' : ''}"
		aria-haspopup="listbox"
		aria-expanded={show}
		{disabled}
	>
		<div class="flex max-w-full items-center {triggerClassName}">
			<span class="min-w-0 truncate">{selectedLabel}</span>
		</div>
	</button>

	<div slot="content" class="w-fit max-w-[calc(100vw-1rem)]">
		<DropdownMenu
			className="max-h-72 w-max max-w-64 overflow-y-auto overflow-x-hidden scrollbar-thin"
		>
			{#each options as option (option.value)}
				<button
					type="button"
					class="text-left"
					aria-pressed={option.value === selectedVariant}
					on:click={() => selectVariant(option.value)}
				>
					<span class="min-w-0 flex-1 truncate">{option.label}</span>

					<span class="flex size-3 shrink-0 items-center justify-center">
						{#if option.value === selectedVariant}
							<Check className="size-3" />
						{/if}
					</span>
				</button>
			{/each}
		</DropdownMenu>
	</div>
</Dropdown>
