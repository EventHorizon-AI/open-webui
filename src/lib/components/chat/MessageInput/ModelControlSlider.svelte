<script lang="ts">
	import { createEventDispatcher, getContext } from 'svelte';
	import type { ModelControl } from '$lib/apis';
	import Tooltip from '$lib/components/common/Tooltip.svelte';
	import QuestionMarkCircle from '$lib/components/icons/QuestionMarkCircle.svelte';

	const i18n: any = getContext('i18n');
	const dispatch = createEventDispatcher<{ change: string }>();
	export let control: ModelControl;
	export let value = '';
	export let disabled = false;

	let trackEl: HTMLDivElement;
	let dragging = false;
	/** Continuous 0..1 pointer position while dragging. */
	let dragRatio: number | null = null;

	$: options = Object.entries(control.options);
	$: count = options.length;
	$: index = Math.max(
		0,
		options.findIndex(([key]) => key === (value || control.default))
	);

	/** Nearest option index for a 0..1 position. */
	const nearestIndex = (ratio: number) => {
		if (count <= 1) return 0;
		return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))));
	};

	// Step-based tracking (like a native range input): the thumb settles onto an option
	// instead of following the pointer continuously, and each hop is animated via CSS.
	$: activeIndex = dragging && dragRatio !== null ? nearestIndex(dragRatio) : index;
	$: display = { ratio: count > 1 ? activeIndex / (count - 1) : 0, index: activeIndex };
	$: progress = display.ratio * 100;
	$: current = options[display.index]?.[0] ?? (value || control.default);
	$: label = control.options[current ?? '']?.label ?? $i18n.t('Default');

	const ratioFromX = (clientX: number) => {
		if (!trackEl) return 0;
		const rect = trackEl.getBoundingClientRect();
		const usable = rect.width - 16; // thumb is 1rem wide; travel excludes half on each side
		if (usable <= 0) return 0;
		return Math.min(1, Math.max(0, (clientX - rect.left - 8) / usable));
	};

	const onPointerDown = (event: PointerEvent) => {
		if (disabled) return;
		dragging = true;
		dragRatio = ratioFromX(event.clientX);
		(event.currentTarget as HTMLElement).focus();
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {
			/* ignore */
		}
		event.preventDefault();
	};

	const onPointerMove = (event: PointerEvent) => {
		if (!dragging) return;
		dragRatio = ratioFromX(event.clientX);
	};

	const onPointerUp = (event: PointerEvent) => {
		if (!dragging) return;
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
		} catch {
			/* ignore */
		}
		const next = nearestIndex(dragRatio ?? 0);
		dragging = false;
		dragRatio = null;
		dispatch('change', options[next][0]);
	};

	const onKeydown = (event: KeyboardEvent) => {
		if (disabled) return;
		let next = index;
		if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = Math.max(0, index - 1);
		else if (event.key === 'ArrowRight' || event.key === 'ArrowUp')
			next = Math.min(count - 1, index + 1);
		else if (event.key === 'Home') next = 0;
		else if (event.key === 'End') next = count - 1;
		else return;
		event.preventDefault();
		if (next !== index) dispatch('change', options[next][0]);
	};
</script>

<div class="space-y-2 px-2 py-2 text-xs">
	<div class="flex items-center gap-2">
		<span class="text-gray-700 dark:text-gray-100">{control.label}</span>
		<span class="min-w-0 flex-1 truncate text-gray-500 dark:text-gray-400">{label}</span>
		{#if control.description}
			<Tooltip content={control.description}>
				<button
					type="button"
					aria-label={control.description}
					class="text-gray-400 transition-colors duration-150 hover:text-gray-600 dark:hover:text-gray-200"
				>
					<QuestionMarkCircle className="size-3.5" />
				</button>
			</Tooltip>
		{/if}
	</div>
	<div class="space-y-1">
		<div
			class="flex justify-between gap-2 text-[0.6875rem] text-gray-500 dark:text-gray-400"
			aria-hidden="true"
		>
			<span class="truncate">{options[0]?.[1].label}</span>
			<span class="truncate text-right">{options.at(-1)?.[1].label}</span>
		</div>

		<div
			bind:this={trackEl}
			class="slider relative flex h-5 cursor-pointer touch-none select-none items-center rounded-md outline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-gray-400 [--slider-fill:var(--color-gray-300)] dark:[--slider-fill:var(--color-gray-600)]"
			class:is-disabled={disabled}
			role="slider"
			tabindex={disabled ? -1 : 0}
			aria-label={control.label}
			aria-valuemin="0"
			aria-valuemax={count - 1}
			aria-valuenow={display.index}
			aria-valuetext={label}
			aria-orientation="horizontal"
			aria-disabled={disabled}
			on:pointerdown={onPointerDown}
			on:pointermove={onPointerMove}
			on:pointerup={onPointerUp}
			on:pointercancel={onPointerUp}
			on:keydown={onKeydown}
		>
			<div
				class="pointer-events-none absolute inset-0 rounded-md bg-gray-100 dark:bg-gray-800"
				aria-hidden="true"
			></div>
			<div class="pointer-events-none absolute inset-x-2 inset-y-0" aria-hidden="true">
				<div
					class="slider-fill absolute inset-y-0 -left-2 rounded-md bg-[var(--slider-fill)]"
					class:dragging
					style:width={`${progress}%`}
				></div>
				{#each options as [key], i (key)}
					<span
						class="absolute top-1/2 size-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-400 dark:bg-gray-500"
						style:left={`${(i / Math.max(1, count - 1)) * 100}%`}
					></span>
				{/each}
				<div
					class="slider-thumb absolute top-1/2 z-10"
					class:dragging
					style:left={`${display.ratio * 100}%`}
				></div>
			</div>
		</div>
	</div>
	<button
		type="button"
		disabled={disabled || !value}
		on:click={() => dispatch('change', '')}
		class="text-[0.6875rem] text-gray-500 transition-colors duration-150 enabled:hover:text-gray-900 dark:text-gray-400 dark:enabled:hover:text-gray-100"
	>
		{$i18n.t('Default')}{#if control.options[control.default ?? '']?.label}{' · '}{control.options[
				control.default ?? ''
			].label}{/if}
	</button>
</div>

<style>
	/* The right padding reaches the thumb centre and, together with `-left-2` on the element,
	   makes the fill cover the whole track width (0 → thumb centre). */
	.slider-fill {
		box-sizing: content-box;
		padding-right: 0.5rem;
		transition: width 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* While dragging the value hops between options, so keep the same animation (quicker)
	   instead of disabling it. */
	.slider-fill.dragging {
		transition: width 90ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	.slider-thumb {
		width: 1rem;
		height: 1.25rem;
		border-radius: 0.375rem;
		background: white;
		box-shadow: 0 1px 3px #0003;
		transform: translate(-50%, -50%);
		transition: left 140ms cubic-bezier(0.22, 1, 0.36, 1);
	}
	/* Kept animated while dragging too, so every step change glides into place. */
	.slider-thumb.dragging {
		transition: left 90ms cubic-bezier(0.22, 1, 0.36, 1);
	}

	@media (prefers-reduced-motion: reduce) {
		.slider-fill,
		.slider-thumb {
			transition: none;
		}
	}
</style>
