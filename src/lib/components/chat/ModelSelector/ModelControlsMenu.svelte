<script lang="ts">
	import { getContext } from 'svelte';
	import { settings, type Model } from '$lib/stores';
	import type { ModelControl } from '$lib/apis';
	import { updateUserSettings } from '$lib/apis/users';
	import { toast } from 'svelte-sonner';
	import ChevronRight from '$lib/components/icons/ChevronRight.svelte';
	import ChevronLeft from '$lib/components/icons/ChevronLeft.svelte';
	import Check from '$lib/components/icons/Check.svelte';
	import ModelControlSlider from '$lib/components/chat/MessageInput/ModelControlSlider.svelte';
	import { localizeModelControls } from '$lib/utils/localizedContent';

	const i18n: any = getContext('i18n');

	export let model: Model;

	let saving = false;
	/** The control whose options are currently being picked (drill-in). */
	let active: { key: string; control: ModelControl } | null = null;

	$: modelControls = $settings?.params?.model_controls ?? {};
	$: controls = localizeModelControls(model, $i18n.language);

	$: rowClass = `focus-ring flex h-[1.6875rem] w-full cursor-pointer select-none items-center gap-2 rounded-xl px-2 text-left text-[0.8125rem] font-normal text-gray-700 outline-hidden transition-colors duration-75 dark:text-gray-100 ${$settings?.highContrastMode ? 'hover:bg-gray-200! dark:hover:bg-gray-800!' : 'hover:bg-gray-50/40! dark:hover:bg-gray-800/40!'}`;
	$: selectedClass = $settings?.highContrastMode
		? 'bg-gray-200 dark:bg-gray-800'
		: 'bg-gray-50/70 dark:bg-gray-800/60';

	const optionLabel = (key: string, control: ModelControl) => {
		const value = modelControls[model.id]?.[key] ?? control.default ?? '';
		return control.options?.[value]?.label ?? '';
	};

	const select = async (key: string, value: string) => {
		// Return to the controls list after picking, so several controls can be set in a row.
		active = null;
		const previous = modelControls;
		const modelOptions = { ...modelControls[model.id] };
		if (value) modelOptions[key] = value;
		else delete modelOptions[key];
		settings.set({
			...$settings,
			params: {
				...$settings.params,
				model_controls: { ...modelControls, [model.id]: modelOptions }
			}
		});
		saving = true;
		try {
			if (!(await updateUserSettings(localStorage.token, { ui: { params: $settings.params } }))) {
				throw new Error($i18n.t('Failed to save settings'));
			}
		} catch (error) {
			settings.set({ ...$settings, params: { ...$settings.params, model_controls: previous } });
			toast.error(String(error));
		} finally {
			saving = false;
		}
	};
</script>

{#if active}
	<button
		type="button"
		aria-label={$i18n.t('Back')}
		class={rowClass}
		on:click={() => (active = null)}
	>
		<ChevronLeft className="size-3.5 shrink-0" />
		<span class="min-w-0 flex-1 truncate text-left">{active.control.label}</span>
	</button>

	{#if active.control.description}
		<p class="px-2 py-1.5 text-xs leading-4 text-gray-500 dark:text-gray-400">
			{active.control.description}
		</p>
	{/if}

	<button
		type="button"
		role="menuitemradio"
		disabled={saving}
		aria-checked={!modelControls[model.id]?.[active.key]}
		class={`${rowClass} ${!modelControls[model.id]?.[active.key] ? selectedClass : ''}`}
		on:click={() => select(active.key, '')}
	>
		<span class="min-w-0 flex-1 truncate text-left">
			{$i18n.t(
				'Default'
			)}{#if active.control.options?.[active.control.default ?? '']?.label}{' · '}{active.control
					.options[active.control.default ?? ''].label}{/if}
		</span>
		{#if !modelControls[model.id]?.[active.key]}<Check className="size-3! shrink-0" />{/if}
	</button>

	{#each Object.entries(active.control.options) as [value, option] (value)}
		<button
			type="button"
			role="menuitemradio"
			disabled={saving}
			aria-checked={modelControls[model.id]?.[active.key] === value}
			class={`${rowClass} ${modelControls[model.id]?.[active.key] === value ? selectedClass : ''}`}
			on:click={() => select(active.key, value)}
		>
			<span class="min-w-0 flex-1 truncate text-left">{option.label}</span>
			{#if modelControls[model.id]?.[active.key] === value}<Check
					className="size-3! shrink-0"
				/>{/if}
		</button>
	{/each}
{:else}
	{#each Object.entries(controls) as [key, control] (key)}
		{#if control.display === 'slider'}
			<ModelControlSlider
				{control}
				value={modelControls[model.id]?.[key] ?? ''}
				disabled={saving}
				on:change={(event) => select(key, event.detail)}
			/>
		{:else}
			<button
				type="button"
				class={rowClass}
				aria-label={control.label}
				on:click={() => (active = { key, control })}
			>
				<span class="min-w-0 flex-1 truncate text-left">{control.label}</span>
				<span class="max-w-[55%] truncate text-gray-500 dark:text-gray-400">
					{optionLabel(key, control) || $i18n.t('Default')}
				</span>
				<ChevronRight className="size-3.5 shrink-0 text-gray-400" />
			</button>
		{/if}
	{/each}
{/if}
