<script lang="ts">
	import { getContext, onDestroy, onMount, tick } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';

	import { settings } from '$lib/stores';
	import { buildExcerptHtml, excerptText, truncateText } from '$lib/utils/message-rail';

	type RailMessage = {
		id?: string;
		role?: string;
	};

	export let messages: RailMessage[] = [];
	export let containerId = 'messages-container';

	const i18n: Writable<i18nType> = getContext('i18n');

	const markerStep = 10;
	const railWidth = 36;

	let mounted = false;
	let container: HTMLElement | null = null;
	let log: HTMLElement | null = null;

	let railEl: HTMLDivElement | null = null;
	let scrollerEl: HTMLDivElement | null = null;
	let contentEl: HTMLDivElement | null = null;
	let canvasEl: HTMLCanvasElement | null = null;
	let previewEl: HTMLDivElement | null = null;
	let context: CanvasRenderingContext2D | null = null;

	let railEnabled = true;
	let lastRailEnabled = true;

	let items: HTMLElement[] = [];
	let itemIds: string[] = [];
	let positions: number[] = [];
	let messageColumnRight = 0;
	let measuredItem: HTMLElement | null = null;
	let messageById = new Map<string, RailMessage>();

	let railVisible = false;
	let railScrollable = false;
	let railPositioned = false;
	let railTop = 0;
	let railLeft = 0;
	let railHeight = 0;
	let hovered = -1;
	let active = 0;
	let hoverY = -1;

	let dragging = false;
	let dragPointer = -1;
	let dragY = 0;
	let dragTop = 0;
	let suppressClick = false;
	let keyboardPreview = false;

	let previewVisible = false;
	let previewPositioned = false;
	let previewLeft = 0;
	let previewTop = 0;
	let previewRole = 'Assistant';
	let promptText = '';
	let snippetHtml = '';
	let snippetFallback = '';
	let outputs: string[] = [];
	let moreOutputs = 0;
	let previewDirty = true;

	let scheduledBuild = 0;
	let scheduledSync = 0;
	let previewRefresh = 0;
	let previewFrame = 0;

	$: railEnabled = $settings?.chatMessageRail ?? true;

	$: if (mounted && railEnabled !== lastRailEnabled) {
		lastRailEnabled = railEnabled;
		sync();
	}

	$: if (mounted) {
		const nextMessages = new Map<string, RailMessage>();
		for (const message of messages ?? []) {
			if (message?.id) nextMessages.set(message.id, message);
		}
		messageById = nextMessages;
		resolveItemIds();
		draw();
	}

	let logObserver: MutationObserver | null = null;
	let sizeObserver: ResizeObserver | null = null;
	let pageObserver: MutationObserver | null = null;
	let themeObserver: MutationObserver | null = null;

	function installObservers() {
		logObserver = new MutationObserver((records) => {
			previewDirty = true;
			if (records.some((record) => record.target === log)) scheduleBuild();
			if (hovered >= 0 && !previewRefresh) {
				previewRefresh = window.setTimeout(() => {
					previewRefresh = 0;
					if (hovered >= 0 && previewVisible) {
						previewDirty = true;
						showPreview(hovered, markerClientY(hovered));
					}
				}, 120);
			}
		});

		sizeObserver = new ResizeObserver(scheduleBuild);
		pageObserver = new MutationObserver(scheduleSync);
		themeObserver = new MutationObserver(draw);
	}

	function portal(node: HTMLElement) {
		document.body.appendChild(node);
		return {
			destroy() {
				node.remove();
			}
		};
	}

	function clamp(value: number, min: number, max: number) {
		return Math.min(max, Math.max(min, value));
	}

	function scheduleSync() {
		if (!mounted || scheduledSync) return;
		scheduledSync = requestAnimationFrame(() => {
			scheduledSync = 0;
			sync();
		});
	}

	function sync() {
		if (!mounted) return;
		if (!railEnabled) {
			detach();
			return;
		}

		const nextContainer = document.getElementById(containerId);
		const nextLog = nextContainer?.querySelector(
			'section[aria-labelledby="chat-conversation"] > ul[role="log"]'
		) as HTMLElement | null;

		if (!nextContainer || !nextLog) {
			detach();
			return;
		}

		if (nextContainer !== container || nextLog !== log) attach(nextContainer, nextLog);
	}

	function attach(nextContainer: HTMLElement, nextLog: HTMLElement) {
		resetRail();
		container = nextContainer;
		log = nextLog;

		container.addEventListener('scroll', updateActive, { passive: true });
		logObserver?.observe(log, { childList: true, subtree: true, characterData: true });
		sizeObserver?.observe(log);
		sizeObserver?.observe(container);

		scheduleBuild();
	}

	function detach() {
		resetRail();
		container = null;
		log = null;
	}

	function resetRail() {
		if (scheduledBuild) cancelAnimationFrame(scheduledBuild);
		scheduledBuild = 0;
		if (previewFrame) cancelAnimationFrame(previewFrame);
		previewFrame = 0;
		clearTimeout(previewRefresh);
		previewRefresh = 0;
		previewDirty = true;

		logObserver?.disconnect();
		sizeObserver?.disconnect();
		container?.removeEventListener('scroll', updateActive);

		railVisible = false;
		railScrollable = false;
		railPositioned = false;
		previewVisible = false;
		previewPositioned = false;
		items = [];
		itemIds = [];
		positions = [];
		measuredItem = null;
		hovered = -1;
		active = 0;
		hoverY = -1;
		dragging = false;
		dragPointer = -1;
		suppressClick = false;
		keyboardPreview = false;
	}

	function scheduleBuild() {
		if (!mounted) return;
		if (!scheduledBuild) {
			scheduledBuild = requestAnimationFrame(() => {
				scheduledBuild = 0;
				build();
			});
		}
	}

	function build() {
		if (!container || !log || !log.isConnected) {
			sync();
			return;
		}

		const nextItems = Array.from(log.children).filter(
			(node): node is HTMLElement =>
				node instanceof HTMLElement && node.getAttribute('role') === 'listitem'
		);

		const previousId = hovered >= 0 ? itemIds[hovered] : '';
		const changed =
			nextItems.length !== items.length || nextItems.some((node, index) => node !== items[index]);

		items = nextItems;
		resolveItemIds();

		if (items[0] !== measuredItem) {
			if (measuredItem) sizeObserver?.unobserve(measuredItem);
			measuredItem = items[0] ?? null;
			if (measuredItem) sizeObserver?.observe(measuredItem);
		}

		if (changed) {
			const nextIndex = previousId ? itemIds.indexOf(previousId) : -1;
			if (nextIndex < 0) {
				hidePreview();
			} else {
				hovered = nextIndex;
				previewDirty = true;
			}
		}

		if (!items.length) {
			railVisible = false;
			return;
		}

		const scrollable = hasScrollableHistory();

		const box = container.getBoundingClientRect();
		messageColumnRight = box.left;
		positions = items.map((node) => {
			const rect = node.getBoundingClientRect();
			messageColumnRight = Math.max(messageColumnRight, rect.right);
			return rect.top - box.top + container!.scrollTop;
		});
		active = currentIndex();

		positionRail(scrollable);
		updateActive();

		if (!railVisible && previewVisible) hidePreview();
		if (hovered >= 0 && previewVisible) {
			updatePreviewContent(hovered);
			positionPreviewSoon();
		}
	}

	function resolveItemIds() {
		itemIds = items.map((item) => {
			for (const element of item.querySelectorAll('[id^="message-"]')) {
				const id = element.id.startsWith('message-') ? element.id.slice(8) : '';
				if (messageById.has(id)) return id;
			}
			return '';
		});
	}

	function hasScrollableHistory() {
		if (!container || container.clientHeight <= 0) return false;

		return container.scrollHeight - container.clientHeight > 16;
	}

	function positionRail(scrollable: boolean) {
		if (!container) return;

		const box = container.getBoundingClientRect();
		const availableTop = Math.max(4, box.top + 12);
		const availableBottom = Math.min(window.innerHeight - 4, box.bottom - 12);
		const available = Math.max(0, availableBottom - availableTop);
		const inset = box.width > 720 ? 12 : 4;

		// Only show the rail when there is enough empty space to the right of the
		// message column for it to sit without covering message content.
		if (
			!scrollable ||
			available < 32 ||
			!items.length ||
			box.right - messageColumnRight < railWidth + inset + 8
		) {
			railVisible = false;
			if (railEl) railEl.hidden = true;
			return;
		}

		const height = Math.min(
			available,
			Math.min(window.innerHeight * 0.7, 640),
			Math.max(28, items.length * markerStep)
		);

		railVisible = true;
		railTop = availableTop + (available - height) / 2;
		railLeft = Math.max(
			box.left + 4,
			Math.min(box.right - railWidth - inset, window.innerWidth - railWidth - 8)
		);
		railHeight = height;
		railScrollable = items.length * markerStep > height + 1 && height >= 100;

		if (railEl) {
			railEl.hidden = false;
			railEl.style.top = `${railTop}px`;
			railEl.style.left = `${railLeft}px`;
			railEl.style.height = `${railHeight}px`;
		}
		if (contentEl) contentEl.style.height = `${items.length * markerStep}px`;

		const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
		const canvasWidth = Math.round(railWidth * pixelRatio);
		const canvasHeight = Math.round(height * pixelRatio);
		if (canvasEl && (canvasEl.width !== canvasWidth || canvasEl.height !== canvasHeight)) {
			canvasEl.width = canvasWidth;
			canvasEl.height = canvasHeight;
		}
		if (context) context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);

		revealMarker(active, !railPositioned);
		railPositioned = true;
		draw();
	}

	function markerAt(clientY: number) {
		if (!railEl || !scrollerEl || !items.length) return -1;

		const box = railEl.getBoundingClientRect();
		return clamp(
			Math.floor((clientY - box.top + scrollerEl.scrollTop) / markerStep),
			0,
			items.length - 1
		);
	}

	function markerClientY(index: number) {
		if (!railEl || !scrollerEl) return 0;

		const box = railEl.getBoundingClientRect();
		return box.top + index * markerStep + markerStep / 2 - scrollerEl.scrollTop;
	}

	function revealMarker(index: number, center = false) {
		if (!scrollerEl || index < 0 || !railVisible) return;

		const top = index * markerStep;
		const bottom = top + markerStep;
		const viewTop = scrollerEl.scrollTop;
		const viewBottom = viewTop + scrollerEl.clientHeight;

		if (center || top < viewTop + 20 || bottom > viewBottom - 20) {
			const next = center
				? top - (scrollerEl.clientHeight - markerStep) / 2
				: top < viewTop + 20
					? top - 24
					: bottom - scrollerEl.clientHeight + 24;

			scrollerEl.scrollTop = Math.max(0, next);
			draw();
		}
	}

	function currentIndex() {
		if (!positions.length || !container) return 0;

		const target = container.scrollTop + container.clientHeight * 0.3;
		let low = 0;
		let high = positions.length - 1;

		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (positions[middle] <= target) low = middle;
			else high = middle - 1;
		}

		return low;
	}

	function updateActive() {
		if (!container) return;

		active = currentIndex();
		if (hovered < 0) revealMarker(active);
		draw();
	}

	function jump(index: number) {
		if (!container || !items[index]) return;

		const target = items[index];
		const top =
			target.getBoundingClientRect().top -
			container.getBoundingClientRect().top +
			container.scrollTop;

		container.scrollTo({ top: Math.max(0, top - 24), behavior: 'auto' });
		active = index;
		revealMarker(index);
		draw();
	}

	function roleOf(index: number) {
		const id = itemIds[index];
		const message = id ? messageById.get(id) : null;

		if (message?.role === 'user') return 'You';
		if (message?.role) return 'Assistant';
		return items[index]?.querySelector('.chat-user') ? 'You' : 'Assistant';
	}

	function contentOf(item: HTMLElement | null, role: 'You' | 'Assistant') {
		if (!item) return null;

		if (role === 'You') {
			return item.querySelector('.chat-user .markdown-prose, .chat-user .whitespace-pre-wrap');
		}

		return item.querySelector('.chat-assistant #response-content-container');
	}

	function findPreviousUser(index: number) {
		for (let i = index - 1; i >= 0; i--) {
			if (roleOf(i) === 'You') return i;
		}
		return -1;
	}

	function updatePreviewContent(index: number) {
		const selected = items[index];
		if (!selected) return;

		previewRole = roleOf(index);

		const promptIndex = previewRole === 'You' ? index : findPreviousUser(index);
		const responseIndex =
			previewRole === 'You'
				? index + 1 < items.length && roleOf(index + 1) === 'Assistant'
					? index + 1
					: -1
				: index;
		const promptItem = promptIndex >= 0 ? items[promptIndex] : null;
		const responseItem = responseIndex >= 0 ? items[responseIndex] : null;

		promptText = truncateText(
			excerptText(buildExcerptHtml(contentOf(promptItem, 'You'), 700)),
			190
		);

		snippetHtml = buildExcerptHtml(contentOf(responseItem, 'Assistant'));
		snippetFallback = responseItem ? $i18n.t('No text response') : $i18n.t('No response yet');

		collectOutputs(promptItem, responseItem);
	}

	function collectOutputs(promptItem: HTMLElement | null, responseItem: HTMLElement | null) {
		const labels: string[] = [];
		const seen = new Set<string>();

		for (const item of [promptItem, responseItem]) {
			const message = item?.querySelector('.chat-user, .chat-assistant');
			if (!message) continue;

			for (const node of message.querySelectorAll(
				'img, button.relative.group, iframe, a[download], audio, video'
			)) {
				if (node.closest('[hidden], .hidden, details')) continue;

				let kind = '';
				let name = '';

				if (node.tagName === 'IMG') {
					kind = $i18n.t('Image');
					name = node.getAttribute('alt') ?? '';
				} else if (node.tagName === 'IFRAME') {
					kind = $i18n.t('Preview');
					name = node.getAttribute('title') ?? '';
				} else if (node.tagName === 'A') {
					kind = $i18n.t('File');
					name = node.textContent?.trim() ?? '';
				} else if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') {
					kind = node.tagName === 'AUDIO' ? $i18n.t('Audio') : $i18n.t('Video');
				} else {
					kind = $i18n.t('File');
					name =
						node.querySelector('.truncate.font-normal, .line-clamp-1')?.textContent?.trim() ?? '';
					if (!name) continue;
				}

				const label = name && name.toLowerCase() !== kind.toLowerCase() ? `${kind}: ${name}` : kind;
				const key = `${kind}:${
					node.getAttribute('src') ?? node.getAttribute('href') ?? name ?? labels.length
				}`;

				if (!seen.has(key)) {
					seen.add(key);
					labels.push(label);
				}
			}
		}

		outputs = labels.slice(0, 3);
		moreOutputs = Math.max(0, labels.length - 3);
	}

	function draw() {
		if (!context || !railVisible) return;

		context.clearRect(0, 0, railWidth, railHeight);
		if (!items.length) return;

		const dark = document.documentElement.classList.contains('dark');
		const scrollTop = scrollerEl?.scrollTop ?? 0;
		const first = Math.max(0, Math.floor(scrollTop / markerStep) - 1);
		const last = Math.min(items.length, Math.ceil((scrollTop + railHeight) / markerStep) + 1);

		for (let i = first; i < last; i++) {
			const y = Math.round(i * markerStep + markerStep / 2 - scrollTop);
			const distance = hovered < 0 ? Infinity : Math.abs(i - hovered);
			const strength =
				distance === 0 ? 1 : distance === 1 ? 0.7 : distance === 2 ? 0.4 : distance === 3 ? 0.2 : 0;
			const isHovered = i === hovered;
			const showActive = hovered < 0 && i === active;
			const base = roleOf(i) === 'You' ? 12 : 8;
			const length = Math.round(base + (26 - base) * (showActive ? 0.35 : strength));

			context.fillStyle = isHovered
				? dark
					? '#f5f5f5'
					: '#242424'
				: showActive
					? dark
						? '#bdbdbd'
						: '#555'
					: dark
						? '#626262'
						: '#9b9b9b';

			context.fillRect(railWidth - 2 - length, y - 1, length, 2);
		}
	}

	function showPreview(index: number, clientY: number) {
		if (!railEl || index < 0 || !items[index] || !railVisible) return;

		if (index !== hovered || previewDirty) {
			previewDirty = false;
			updatePreviewContent(index);
		}

		hovered = index;
		previewVisible = true;

		const box = railEl.getBoundingClientRect();
		hoverY = clamp(clientY - box.top, 0, box.height);
		positionPreviewSoon();
		draw();
	}

	function hidePreview() {
		hovered = -1;
		hoverY = -1;
		keyboardPreview = false;
		previewVisible = false;
		previewPositioned = false;
		draw();
	}

	function positionPreviewSoon() {
		if (previewFrame) cancelAnimationFrame(previewFrame);
		previewFrame = requestAnimationFrame(() => {
			previewFrame = 0;
			void positionPreview();
		});
	}

	async function positionPreview() {
		if (!previewVisible) return;
		previewPositioned = false;
		await tick();
		if (!previewVisible || !previewEl || !railEl) return;

		const box = railEl.getBoundingClientRect();
		const width = previewEl.offsetWidth;
		const height = previewEl.offsetHeight;
		const anchorY = hoverY >= 0 ? box.top + hoverY : box.top;

		previewLeft = Math.max(8, box.left - width - 4);
		previewTop = clamp(anchorY - height / 2, 8, Math.max(8, window.innerHeight - height - 8));
		previewPositioned = true;
	}

	function handlePointerDown(event: PointerEvent) {
		if (event.button !== 0 || !event.isPrimary || !container || !railEl) return;

		dragPointer = event.pointerId;
		dragY = event.clientY;
		dragTop = container.scrollTop;
		dragging = false;
		suppressClick = false;
		railEl.setPointerCapture(event.pointerId);
	}

	function handlePointerMove(event: PointerEvent) {
		if (!railEl || !container) return;

		if (event.pointerId === dragPointer) {
			const delta = event.clientY - dragY;

			if (!dragging && Math.abs(delta) >= 4) {
				dragging = true;
				suppressClick = true;
				previewVisible = false;
				keyboardPreview = false;
			}

			if (dragging) {
				const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
				const box = railEl.getBoundingClientRect();
				const travel =
					delta >= 0 ? box.bottom - markerStep / 2 - dragY : dragY - box.top - markerStep / 2;
				const remaining = delta >= 0 ? maxScroll - dragTop : dragTop;

				container.scrollTop = clamp(
					dragTop + (delta * remaining) / Math.max(1, travel),
					0,
					maxScroll
				);

				if (maxScroll > 0 && scrollerEl) {
					const maxRailScroll = Math.max(0, scrollerEl.scrollHeight - scrollerEl.clientHeight);
					scrollerEl.scrollTop = (maxRailScroll * container.scrollTop) / maxScroll;
				}

				hovered = markerAt(event.clientY);
				hoverY = clamp(event.clientY - box.top, 0, railEl.clientHeight);
				draw();
				return;
			}
		}

		keyboardPreview = false;
		showPreview(markerAt(event.clientY), event.clientY);
	}

	function handlePointerUp(event: PointerEvent) {
		if (event.pointerId !== dragPointer) return;

		const wasDragging = dragging;
		dragPointer = -1;
		dragging = false;

		if (railEl?.hasPointerCapture(event.pointerId)) {
			railEl.releasePointerCapture(event.pointerId);
		}

		if (wasDragging) {
			hidePreview();
			updateActive();
			window.setTimeout(() => {
				suppressClick = false;
			}, 0);
		}
	}

	function handlePointerCancel(event: PointerEvent) {
		if (event.pointerId !== dragPointer) return;

		dragPointer = -1;
		dragging = false;
		hidePreview();
		updateActive();
	}

	function handleLostPointerCapture(event: PointerEvent) {
		if (event.pointerId !== dragPointer) return;

		dragPointer = -1;
		dragging = false;
		hidePreview();
		updateActive();
	}

	function handleWheel(event: WheelEvent) {
		if (!container || !scrollerEl) return;
		if (scrollerEl.scrollHeight > scrollerEl.clientHeight + 1) return;

		event.preventDefault();
		container.scrollTop += event.deltaY;
	}

	function handleScrollerScroll() {
		if (dragging) {
			draw();
			return;
		}

		if (!keyboardPreview && hovered >= 0 && hoverY >= 0 && railEl) {
			const clientY = railEl.getBoundingClientRect().top + hoverY;
			showPreview(markerAt(clientY), clientY);
		} else {
			draw();
		}
	}

	function handleRailClick(event: MouseEvent) {
		if (suppressClick) {
			suppressClick = false;
			return;
		}

		jump(markerAt(event.clientY));
	}

	function handleKeydown(event: KeyboardEvent) {
		let index = hovered >= 0 ? hovered : active;

		if (event.key === 'ArrowDown') {
			index = Math.min(items.length - 1, index + 1);
		} else if (event.key === 'ArrowUp') {
			index = Math.max(0, index - 1);
		} else if (event.key === 'Home') {
			index = 0;
		} else if (event.key === 'End') {
			index = items.length - 1;
		} else if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			jump(index);
			return;
		} else if (event.key === 'Escape') {
			hidePreview();
			return;
		} else {
			return;
		}

		event.preventDefault();
		keyboardPreview = true;
		revealMarker(index);
		showPreview(index, markerClientY(index));
	}

	function handleRailPointerLeave() {
		if (dragging || keyboardPreview) return;

		hidePreview();
	}

	function handleRailBlur() {
		hidePreview();
	}

	function handleVisibilityChange() {
		if (document.hidden) hidePreview();
	}

	function start() {
		mounted = true;
		installObservers();

		pageObserver?.observe(document.body, { childList: true, subtree: true });
		themeObserver?.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class']
		});

		document.addEventListener('visibilitychange', handleVisibilityChange);
		window.addEventListener('resize', scheduleBuild);

		context = canvasEl?.getContext('2d') ?? null;
		lastRailEnabled = railEnabled;
		sync();
	}

	onMount(() => {
		start();

		return () => {
			mounted = false;
			detach();

			pageObserver?.disconnect();
			themeObserver?.disconnect();
			if (scheduledSync) cancelAnimationFrame(scheduledSync);
			scheduledSync = 0;
			if (previewFrame) cancelAnimationFrame(previewFrame);
			previewFrame = 0;
			clearTimeout(previewRefresh);

			document.removeEventListener('visibilitychange', handleVisibilityChange);
			window.removeEventListener('resize', scheduleBuild);
		};
	});

	onDestroy(() => {
		if (scheduledBuild) cancelAnimationFrame(scheduledBuild);
		scheduledBuild = 0;
	});
</script>

<div
	bind:this={railEl}
	use:portal
	id="message-rail"
	class="fixed z-40 box-border w-[36px] cursor-pointer touch-none select-none rounded-lg outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500 print:hidden"
	class:cursor-grabbing={dragging}
	role="slider"
	aria-label={$i18n.t('Chat message history')}
	aria-orientation="vertical"
	aria-valuemin={1}
	aria-valuemax={Math.max(1, items.length)}
	aria-valuenow={Math.min(Math.max(1, items.length), (hovered >= 0 ? hovered : active) + 1)}
	aria-valuetext={hovered >= 0
		? `${$i18n.t(previewRole)} · ${$i18n.t('Message {{current}} of {{total}}', {
				current: hovered + 1,
				total: items.length
			})}`
		: $i18n.t('Message {{current}} of {{total}}', {
				current: active + 1,
				total: items.length
			})}
	aria-details={previewVisible ? 'message-preview' : undefined}
	tabindex="0"
	hidden={!railVisible}
	style:top={`${railTop}px`}
	style:left={`${railLeft}px`}
	style:height={`${railHeight}px`}
	on:pointerdown={handlePointerDown}
	on:pointermove={handlePointerMove}
	on:pointerup={handlePointerUp}
	on:pointercancel={handlePointerCancel}
	on:lostpointercapture={handleLostPointerCapture}
	on:pointerleave={handleRailPointerLeave}
	on:click={handleRailClick}
	on:keydown={handleKeydown}
	on:blur={handleRailBlur}
	on:wheel|nonpassive={handleWheel}
>
	<div
		bind:this={scrollerEl}
		class="scrollbar-none absolute inset-0 overflow-x-hidden overflow-y-auto overscroll-contain"
		aria-hidden="true"
		on:scroll={handleScrollerScroll}
	>
		<div bind:this={contentEl}></div>
	</div>

	<canvas
		bind:this={canvasEl}
		class="pointer-events-none absolute inset-0 block h-full w-[36px] {railScrollable
			? '[mask-image:linear-gradient(to_bottom,transparent,black_40px,black_calc(100%_-_40px),transparent)]'
			: ''}"
		aria-hidden="true"
	></canvas>
</div>

{#if previewVisible}
	<div
		bind:this={previewEl}
		use:portal
		id="message-preview"
		class="fixed z-[41] box-border w-[min(360px,calc(100vw_-_56px))] [overflow-wrap:anywhere] print:hidden"
		class:invisible={!previewPositioned}
		role="group"
		aria-label={$i18n.t('Message preview')}
		style:left={`${previewLeft}px`}
		style:top={`${previewTop}px`}
	>
		<div
			class="w-full max-w-full rounded-lg border border-gray-900 bg-gray-950 text-xs text-white shadow-xl"
		>
			<div class="px-[11px] py-[9px]">
				<div class="mb-1 flex items-center justify-between gap-2 text-[11px] text-gray-400">
					<strong class="font-semibold">
						{$i18n.t(previewRole)} · {Math.min(items.length, hovered + 1)} / {items.length}
					</strong>
				</div>

				{#if promptText}
					<div class="mb-1.5 line-clamp-2 font-semibold whitespace-pre-wrap">{promptText}</div>
				{/if}

				<div
					class="max-h-40 overflow-hidden text-xs leading-normal [&_blockquote]:my-1 [&_blockquote]:border-s-2 [&_blockquote]:border-white/25 [&_blockquote]:ps-2 [&_code]:font-mono [&_code]:text-[0.95em] [&_h3]:my-1 [&_h3]:text-xs [&_h3]:font-semibold [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:ps-4 [&_p]:mb-1 [&_pre]:my-1 [&_pre]:rounded-md [&_pre]:bg-white/5 [&_pre]:p-1.5 [&_pre]:text-[11px] [&_pre]:leading-snug [&_pre]:break-words [&_pre]:whitespace-pre-wrap [&_table]:w-full [&_table]:table-fixed [&_table]:border-collapse [&_table]:text-[11px] [&_td]:truncate [&_td]:border-b [&_td]:border-white/15 [&_td]:p-1 [&_td]:text-start [&_th]:truncate [&_th]:border-b [&_th]:border-white/15 [&_th]:p-1 [&_th]:text-start [&_ul]:my-1 [&_ul]:list-disc [&_ul]:ps-4"
				>
					{#if snippetHtml}
						<!-- eslint-disable-next-line svelte/no-at-html-tags -- excerpt markup is built from a tag whitelist and escaped text -->
						{@html snippetHtml}
					{:else}
						{snippetFallback}
					{/if}
				</div>

				{#if outputs.length}
					<div class="mt-2 flex min-w-0 items-center gap-2 text-[11px] text-gray-400">
						{#each outputs as label}
							<span class="min-w-0 truncate" title={label}>{label}</span>
						{/each}
						{#if moreOutputs > 0}
							<span class="flex-none">+{moreOutputs}</span>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}
