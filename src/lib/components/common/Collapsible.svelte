<script lang="ts">
	import { decode } from 'html-entities';
	import { v4 as uuidv4 } from 'uuid';

	import { getContext } from 'svelte';
	const i18n = getContext<typeof import('$lib/i18n').default>('i18n');

	import { settings } from '$lib/stores';
	import { get } from 'svelte/store';

	let userSettings = get(settings);

	import dayjs from '$lib/dayjs';
	import duration from 'dayjs/plugin/duration';
	import relativeTime from 'dayjs/plugin/relativeTime';

	import { slide } from 'svelte/transition';
	import { quintOut } from 'svelte/easing';

	import ChevronUp from '../icons/ChevronUp.svelte';
	import ChevronDown from '../icons/ChevronDown.svelte';
	import Spinner from './Spinner.svelte';
	import CodeBlock from '../chat/Messages/CodeBlock.svelte';
	import Markdown from '../chat/Messages/Markdown.svelte';
	import Image from './Image.svelte';
	import FullHeightIframe from './FullHeightIframe.svelte';

	dayjs.extend(duration);
	dayjs.extend(relativeTime);

	async function loadLocale(locales) {
		if (!locales || !Array.isArray(locales)) {
			return;
		}
		for (const locale of locales) {
			try {
				dayjs.locale(locale);
				break; // Stop after successfully loading the first available locale
			} catch (error) {
				console.error(`Could not load locale '${locale}':`, error);
			}
		}
	}

	// Assuming $i18n.languages is an array of language codes
	$: loadLocale($i18n.languages);

	let previousDone = false;

	$: {
		if (
			attributes?.type === 'reasoning' &&
			userSettings.expandReasoningBeforeCompletion &&
			attributes?.done !== previousDone
		) {
			if (attributes?.done === 'false') {
				open = true;
			}
			if (attributes?.done === 'true') {
				open = false;
			}
			previousDone = attributes?.done;
		}
	}

	export let open = false;

	export let className = '';
	export let buttonClassName =
		'w-fit py-1 text-[0.9375rem] text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition';

	export let id = '';
	export let title = null;
	export let attributes = null;
	export let chevronClassName = 'size-3';
	export let chevronStrokeWidth = '2.75';

	export let chevron = false;
	export let grow = false;

	export let disabled = false;
	export let messageDone = false;
	export let hide = false;

	export let onChange: Function = () => {};

	const toggleOpen = () => {
		if (disabled) {
			return;
		}

		open = !open;
		onChange(open);
	};

	const collapsibleId = uuidv4();

	// Whether a leading status icon is currently shown (code-interpreter still
	// streaming). The icon swaps to the expand chevron on hover. Reasoning keeps
	// its leading icon but never moves the expand chevron to the front.
	$: hasLeadingIcon = !!(attributes?.done && attributes?.done !== 'true' && !messageDone);
	$: isReasoning = attributes?.type === 'reasoning';
	$: leadingArrow = hasLeadingIcon && !isReasoning;
</script>

<div {id} class={className}>
	{#if title !== null}
		<button
			type="button"
			class="{buttonClassName} group/collapsible block text-start disabled:cursor-default"
			aria-expanded={open}
			{disabled}
			on:click={toggleOpen}
		>
			<div
				class=" w-full flex items-center justify-between gap-2 {attributes?.done &&
				attributes?.done !== 'true' &&
				!messageDone
					? 'shimmer'
					: ''}
			"
			>
				{#if hasLeadingIcon}
					<div class="relative flex size-4 shrink-0 items-center justify-center self-center">
						<div class="flex {leadingArrow ? 'group-hover/collapsible:invisible' : ''}">
							<Spinner className="size-4" />
						</div>

						{#if leadingArrow && !disabled}
							<div
								class="absolute inset-0 hidden items-center justify-center group-hover/collapsible:flex"
							>
								{#if open}
									<ChevronUp strokeWidth={chevronStrokeWidth} className={chevronClassName} />
								{:else}
									<ChevronDown strokeWidth={chevronStrokeWidth} className={chevronClassName} />
								{/if}
							</div>
						{/if}
					</div>
				{/if}

				<div class="flex-1 min-w-0 line-clamp-1">
					{#if attributes?.type === 'reasoning'}
						{#if attributes?.done === 'true' || messageDone}
							{#if attributes?.duration}
								{#if attributes.duration < 1}
									{$i18n.t('Thought for less than a second')}
								{:else if attributes.duration < 60}
									{$i18n.t('Thought for {{DURATION}} seconds', {
										DURATION: attributes.duration
									})}
								{:else}
									{$i18n.t('Thought for {{DURATION}}', {
										DURATION: dayjs
											.duration(attributes.duration, 'seconds')
											.locale($i18n.language)
											.humanize()
									})}
								{/if}
							{:else}
								{$i18n.t('Thought')}
							{/if}
						{:else if !open && title}
							{title}
						{:else}
							{$i18n.t('Thinking...')}
						{/if}
					{:else if attributes?.type === 'code_interpreter'}
						{#if attributes?.done === 'true' || messageDone}
							{$i18n.t('Analyzed')}
						{:else}
							{$i18n.t('Analyzing...')}
						{/if}
					{:else}
						{title}
					{/if}
				</div>

				{#if !disabled && !leadingArrow}
					<div class="flex self-center translate-y-[1px]">
						{#if open}
							<ChevronUp strokeWidth={chevronStrokeWidth} className={chevronClassName} />
						{:else}
							<ChevronDown strokeWidth={chevronStrokeWidth} className={chevronClassName} />
						{/if}
					</div>
				{/if}
			</div>
		</button>
	{:else}
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<div
			class="{buttonClassName} cursor-pointer"
			on:click={(e) => {
				e.stopPropagation();
				toggleOpen();
			}}
		>
			<div>
				<div class="flex items-start justify-between">
					<slot />

					{#if chevron}
						<div class="flex self-start translate-y-1">
							{#if open}
								<ChevronUp strokeWidth={chevronStrokeWidth} className={chevronClassName} />
							{:else}
								<ChevronDown strokeWidth={chevronStrokeWidth} className={chevronClassName} />
							{/if}
						</div>
					{/if}
				</div>

				{#if grow}
					{#if open && !hide}
						<div
							class="flow-root"
							transition:slide={{ duration: 300, easing: quintOut, axis: 'y' }}
							on:click={(e) => {
								e.stopPropagation();
							}}
						>
							<slot name="content" />
						</div>
					{/if}
				{/if}
			</div>
		</div>
	{/if}

	{#if !grow}
		{#if open && !hide}
			<div class="flow-root" transition:slide={{ duration: 300, easing: quintOut, axis: 'y' }}>
				<slot name="content" />
			</div>
		{/if}
	{/if}
</div>
