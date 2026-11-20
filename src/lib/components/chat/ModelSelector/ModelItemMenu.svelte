<script lang="ts">
	import type { CommentsRequest } from '$lib/components/comments/CommentsPanel.svelte';
	import { getContext } from 'svelte';
	import { goto } from '$app/navigation';

	import DropdownMenu from '$lib/components/common/DropdownMenu.svelte';
	import CommentButton from '$lib/components/comments/CommentButton.svelte';
	import Pin from '$lib/components/icons/Pin.svelte';
	import PinSlash from '$lib/components/icons/PinSlash.svelte';
	import ArrowUpTray from '$lib/components/icons/ArrowUpTray.svelte';
	import Link from '$lib/components/icons/Link.svelte';
	import Pencil from '$lib/components/icons/Pencil.svelte';
	import { config, pinnedModels, showSettings, user, visibleControls } from '$lib/stores';
	import GlobeAlt from '$lib/components/icons/GlobeAlt.svelte';
	import { computePosition, flip, shift } from '@floating-ui/dom';

	const i18n = getContext('i18n');

	// FileNav-style context menu: the owner keeps the open state (null = closed) and
	// a right-click simply replaces the coordinates, so the menu can always be
	// re-triggered while it is open.
	export let menu: { x: number; y: number; model: any } | null = null;

	export let onComment: (request: CommentsRequest) => void = () => {};
	export let pinModelHandler: (modelId: string) => void = () => {};
	export let copyLinkHandler: Function = () => {};
	export let deleteModelHandler: Function = () => {};
	export let unloadModelHandler: Function = () => {};
	export let onEdit: () => void = () => {};

	export let onClose: Function = () => {};

	// Anchor at the pointer and keep the menu inside the viewport, mirroring
	// FileNav's directory context menu.
	const positionMenu = (node: HTMLElement, point: { x: number; y: number }) => {
		const update = (point: { x: number; y: number }) => {
			computePosition({ getBoundingClientRect: () => new DOMRect(point.x, point.y) }, node, {
				strategy: 'fixed',
				placement: 'bottom-start',
				middleware: [flip(), shift({ padding: 8 })]
			}).then(({ x, y }) => {
				node.style.left = `${x}px`;
				node.style.top = `${y}px`;
			});
		};
		update(point);
		return { update };
	};

	// The model selector panel is portaled to <body> at z-index 9999, so the menu
	// must be portaled too and sit above it; rendering it in place would leave it
	// hidden behind the panel.
	const portalMenu = (node: HTMLElement) => {
		document.body.appendChild(node);
		return {
			destroy() {
				node.parentNode?.removeChild(node);
			}
		};
	};

	$: canEdit =
		menu?.model?.owned_by !== 'terminal' &&
		(menu?.model?.preset || menu?.model?.info?.base_model_id
			? menu?.model?.info?.user_id === $user?.id
			: $user?.role === 'admin');
	const providerSupportsDelete = (provider = '') => provider === 'llama.cpp';

	$: showComments =
		$config?.features?.enable_comments &&
		$user &&
		menu?.model?.id &&
		!menu?.model?.owner_id &&
		!menu?.model?.arena &&
		(menu?.model?.info || $user?.role === 'admin');
</script>

{#if menu}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		use:portalMenu
		use:positionMenu={menu}
		class="model-selector-child-menu model-item-context-menu fixed z-[9999999]"
		style="z-index: 9999999;"
		on:click|stopPropagation
	>
		<DropdownMenu className="min-w-[9.375rem]">
			{#if canEdit}
				<button
					type="button"
					class="select-none flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs hover:bg-gray-50/40 dark:hover:bg-white/4 transition"
					on:click={(e) => {
						e.stopPropagation();
						e.preventDefault();

						if (menu?.model?.preset || menu?.model?.info?.base_model_id) {
							goto(`/workspace/models/edit?id=${encodeURIComponent(menu?.model?.id ?? '')}`);
						} else {
							showSettings.set({ tab: 'admin:models', state: { id: menu?.model?.id ?? null } });
						}
						onClose();
						onEdit();
					}}
				>
					<Pencil className="size-3" />

					<div class="flex items-center">{$i18n.t('Edit')}</div>
				</button>
			{/if}

			{#if showComments}
				<CommentButton
					{onComment}
					menu
					resource={{ resource_type: 'model', resource_id: menu?.model?.id }}
					className="select-none flex h-[1.6875rem] w-full items-center gap-2 rounded-xl px-2 text-[0.8125rem] hover:bg-gray-50/40 dark:hover:bg-gray-800/40 transition"
					onOpen={() => {
						onClose();
						onEdit();
					}}
				/>
			{/if}

			{#if canEdit}
				{#if $user?.role === 'admin' && (menu?.model?.owned_by === 'ollama' || providerSupportsDelete(menu?.model?.provider))}
					<button
						type="button"
						class="select-none flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs hover:bg-gray-50/40 dark:hover:bg-white/4 transition"
						on:click={(e) => {
							e.stopPropagation();
							e.preventDefault();

							deleteModelHandler(menu?.model);
							onClose();
						}}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							fill="none"
							viewBox="0 0 24 24"
							stroke-width="1.5"
							stroke="currentColor"
							class="size-3"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0"
							/>
						</svg>

						<div class="flex items-center">{$i18n.t('Delete')}</div>
					</button>
				{/if}

				{#if $user?.role === 'admin' && menu?.model?.loaded}
					<button
						type="button"
						class="select-none flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs hover:bg-gray-50/40 dark:hover:bg-white/4 transition"
						on:click={(e) => {
							e.stopPropagation();
							e.preventDefault();

							unloadModelHandler(menu?.model?.id);
							onClose();
						}}
					>
						<ArrowUpTray className="size-3" />

						<div class="flex items-center">{$i18n.t('Eject')}</div>
					</button>
				{/if}

				<hr class="border-gray-50 dark:border-gray-800/30 mx-1 my-0.5" />
			{/if}

			{#if $visibleControls['models.pin']}
				<button
					type="button"
					aria-pressed={$pinnedModels.includes(menu?.model?.id)}
					class="select-none flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs hover:bg-gray-50/40 dark:hover:bg-white/4 transition"
					on:click={(e) => {
						e.stopPropagation();
						e.preventDefault();

						pinModelHandler(menu?.model?.id);
						onClose();
					}}
				>
					{#if $pinnedModels.includes(menu?.model?.id)}
						<PinSlash className="size-3" />
					{:else}
						<Pin className="size-3" />
					{/if}

					<div class="flex items-center">
						{#if $pinnedModels.includes(menu?.model?.id)}
							{$i18n.t('Hide from Sidebar')}
						{:else}
							{$i18n.t('Keep in Sidebar')}
						{/if}
					</div>
				</button>
			{/if}

			<button
				type="button"
				class="select-none flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs hover:bg-gray-50/40 dark:hover:bg-white/4 transition"
				on:click={(e) => {
					e.stopPropagation();
					e.preventDefault();

					copyLinkHandler();
					onClose();
				}}
			>
				<Link className="size-3" />

				<div class="flex items-center">{$i18n.t('Copy Link')}</div>
			</button>

			{#if $config?.features.enable_community_sharing}
				<hr class="border-gray-50 dark:border-gray-800/30 mx-1 my-0.5" />
			{/if}

			{#if $config?.features.enable_community_sharing}
				<button
					type="button"
					class="select-none flex h-7 w-full items-center gap-2 rounded-lg px-2 text-xs hover:bg-gray-50/40 dark:hover:bg-white/4 transition"
					on:click={(e) => {
						e.stopPropagation();
						e.preventDefault();

						window.open(
							`https://openwebui.com/models?q=${encodeURIComponent(menu?.model?.id ?? '')}`,
							'_blank'
						);
						onClose();
					}}
				>
					<GlobeAlt className="size-3" />

					<div class="flex items-center">{$i18n.t('Community Reviews')}</div>
				</button>
			{/if}
		</DropdownMenu>
	</div>
{/if}
