<script lang="ts">
	import { models, pinnedModels, selectedModelVariants, settings, user } from '$lib/stores';
	import { getContext } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Selector from './ModelSelector/Selector.svelte';

	import { updateUserSettings } from '$lib/apis/users';
	import { resolveLocalizedModelName } from '$lib/utils/localizedContent';
	import equal from 'fast-deep-equal';
	const i18n = getContext('i18n');

	export let selectedModels = [''];
	export let disabled = false;

	export let showSetDefault = true;
	export let triggerClassName = 'text-lg';
	export let className = undefined;
	export let placement: 'top' | 'bottom' | 'auto' = 'bottom';
	export let align: 'start' | 'end' = 'start';

	let compareModels = selectedModels.length > 1;
	let selector;

	export const open = () => selector?.open();

	const saveDefaultModel = async () => {
		const hasEmptyModel = selectedModels.filter((it) => it === '');
		if (hasEmptyModel.length) {
			toast.error($i18n.t('Choose a model before saving...'));
			return;
		}
		settings.set({ ...$settings, models: selectedModels });
		await updateUserSettings(localStorage.token, { ui: { models: selectedModels } });

		toast.success($i18n.t('Default model updated'));
	};

	const pinModelHandler = async (modelId) => {
		settings.set({
			...$settings,
			pinnedModels: $pinnedModels.includes(modelId)
				? $pinnedModels.filter((id) => id !== modelId)
				: [...$pinnedModels, modelId]
		});
		await updateUserSettings(localStorage.token, { ui: { pinnedModels: $settings.pinnedModels } });
	};

	$: if (selectedModels.length > 0 && $models.length > 0) {
		const _selectedModels = selectedModels.map((model) =>
			$models.map((m) => m.id).includes(model) ? model : ''
		);

		if (!equal(_selectedModels, selectedModels)) {
			selectedModels = _selectedModels;
		}
	}

	$: if (selectedModels.length > 1 && !compareModels) {
		compareModels = true;
	}

	const getModelVariants = (modelId: string) =>
		$models.find((m) => m.id === modelId)?.info?.meta?.variants ?? [];

	$: primaryModelId = selectedModels.find((modelId) => modelId) ?? '';
	$: selectedVariantName = primaryModelId ? ($selectedModelVariants[primaryModelId] ?? '') : '';
	$: selectedVariantLabel = selectedVariantName
		? (getModelVariants(primaryModelId).find((variant) => variant.name === selectedVariantName)
				?.name ?? '')
		: '';

	const getVariants = (modelId: string) => [
		{ value: '', label: $i18n.t('Default') },
		...getModelVariants(modelId).map((variant) => ({
			value: variant.name,
			label: variant.name
		}))
	];

	const getSelectedVariant = (modelId: string) => $selectedModelVariants[modelId] ?? '';

	const handleVariantSelect = (modelId: string, variantName: string) => {
		selectedModelVariants.update((selections) => ({
			...selections,
			[modelId]: variantName
		}));

		if (!selectedModels.includes(modelId)) {
			selectedModels = [modelId];
		}
	};
</script>

<div class="flex min-w-0 max-w-full flex-col items-start">
	<div class="flex min-w-0 max-w-full">
		<div class="min-w-0 max-w-full overflow-hidden">
			<div class="min-w-0 max-w-full">
				<Selector
					bind:this={selector}
					id="model"
					placeholder={$i18n.t('Select a model')}
					items={$models.map((model) => ({
						value: model.id,
						label: resolveLocalizedModelName(model, $i18n.language),
						model: model
					}))}
					{pinModelHandler}
					{className}
					{triggerClassName}
					{placement}
					{align}
					{showSetDefault}
					onSetDefault={saveDefaultModel}
					multipleEnabled={$user?.role === 'admin' ||
						($user?.permissions?.chat?.multiple_models ?? true)}
					{disabled}
					variantLabel={selectedVariantLabel}
					variantsEnabled
					{getVariants}
					{getSelectedVariant}
					onVariantSelect={handleVariantSelect}
					bind:compareEnabled={compareModels}
					bind:values={selectedModels}
				/>
			</div>
		</div>
	</div>
</div>
