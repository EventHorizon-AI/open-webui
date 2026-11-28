<script lang="ts">
	import { decode } from 'html-entities';
	import { getContext } from 'svelte';
	import type { Writable } from 'svelte/store';
	import type { i18n as i18nType } from 'i18next';
	import { quintOut } from 'svelte/easing';

	import ChevronUp from '$lib/components/icons/ChevronUp.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Sparkles from '$lib/components/icons/Sparkles.svelte';
	import CheckCircle from '$lib/components/icons/CheckCircle.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import FullHeightIframe from '$lib/components/common/FullHeightIframe.svelte';
	import type { MCPAppEmbed } from '$lib/components/chat/Messages/MCPApp.svelte';
	import { agentViewName, type AgentView } from '$lib/components/chat/Messages/agentViews';
	import { toolCallLabel } from '$lib/components/chat/Messages/builtinToolLabels';

	import { settings } from '$lib/stores';

	const i18n = getContext<Writable<i18nType>>('i18n');

	export let id = '';
	export let tokens: Array<{
		summary?: string;
		text?: string;
		view?: AgentView | null;
		attributes?: {
			type?: string;
			name?: string;
			tool_id?: string;
			display_label?: string;
			running_label?: string;
			done?: string;
			id?: string;
			status?: string;
			duration?: string;
			embeds?: string;
			arguments?: string;
		};
	}> = [];

	export let messageDone = true;
	export let groupOpen = false;
	export let allowEmbeds = true;
	export let compactPreview = false;
	export let resolvable = false;
	export let resolvingCallId = '';
	export let onResolve: (callId: string, approved: boolean) => void = () => {};

	// 'details' is the regular tool-list header. 'reasoning' renders a finished
	// reasoning disclosure instead — a plain duration label, no icon. Only
	// process groups use it, and they render only once the message is done.
	export let variant: 'details' | 'reasoning' = 'details';
	export let doneLabel = '';

	let open = $settings?.expandDetails ?? false;

	// A slide variant that measures the body on every animation frame instead of
	// once at creation. Svelte's `slide` samples the body's height synchronously
	// when the element mounts and animates a fixed pixel height with
	// overflow:hidden, so content whose render lands in a later microtask (KaTeX,
	// lazy markdown) grows the body past the animated height and stays clipped
	// until the animation ends — the last entries in the group appear to pop in
	// only then. Driving the height from the live `scrollHeight` follows those
	// late renders instead: the measurement effectively happens after the body
	// has rendered. The same closure drives the outro (t 1 → 0), so collapsing
	// still animates, and interrupting either direction reverses smoothly from
	// the current position.
	const expandSlide = (
		node: HTMLElement,
		params: { duration?: number } = {},
		{ direction }: { direction: 'in' | 'out' }
	) => {
		// Collapsed start state, applied synchronously on mount so there is no
		// flash of full-height content before the first animation frame. Skipped
		// when svelte re-invokes this for an outro (it clears its cached options
		// once the intro completes) — snapping the height to 0 there would blink
		// the body away for a frame before the outro's first tick restores it.
		if (direction === 'in') {
			node.style.overflow = 'hidden';
			node.style.height = '0px';
		}

		return {
			duration: params.duration ?? 300,
			easing: quintOut,
			tick: (t: number) => {
				// Keep the body clipped for the whole animation — including the
				// outro, whose re-invocation must not be relied on for styles —
				// and re-measure every frame so content that rendered after the
				// mount (async KaTeX, lazy markdown) is followed, not clipped.
				node.style.overflow = 'hidden';
				node.style.height = `${t * node.scrollHeight}px`;

				if (t === 1) {
					node.style.height = '';
					node.style.overflow = '';
				}
			}
		};
	};

	$: isReasoningVariant = variant === 'reasoning';

	// "Show reasoning summary only" is read from the settings here instead of
	// being passed in: in that mode the group's reasoning is previewed instead of
	// rendered, so it must not keep the header live on its own. A detail group
	// then follows its own unfinished tool calls and settles as soon as none is
	// left. The reasoning-style header is only used by a process group, which
	// renders done, so the setting leaves it alone.
	$: liveOnActiveToolCalls = !isReasoningVariant && ($settings?.reasoningPreviewOnly ?? false);

	function parseJSONString(str: string) {
		try {
			return parseJSONString(JSON.parse(str));
		} catch (e) {
			return str;
		}
	}

	function isToolResultError(value: unknown): boolean {
		if (typeof value === 'string') {
			const text = value.trim().toLowerCase();
			if (
				text.startsWith('error:') ||
				text.startsWith('exception:') ||
				text.startsWith('traceback') ||
				text.startsWith('http error!')
			) {
				return true;
			}
		}

		let parsed = value;
		while (typeof parsed === 'string') {
			try {
				parsed = JSON.parse(parsed);
			} catch {
				break;
			}
		}
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;

		const result = parsed as Record<string, unknown>;
		const error = result.error;
		if (
			(typeof error === 'string' && error.trim().length > 0) ||
			(typeof error === 'object' && error !== null)
		) {
			return true;
		}

		const status = typeof result.status === 'string' ? result.status.trim().toLowerCase() : '';
		if (status === 'error' || status === 'failed') return true;

		const message = result.message;
		return (
			(result.success === false || result.ok === false) &&
			((typeof message === 'string' && message.trim().length > 0) ||
				(typeof message === 'object' && message !== null))
		);
	}

	$: toolCallCount = tokens.filter((t) => t?.attributes?.type === 'tool_calls').length;
	$: pendingToolTokens = tokens.filter(
		(t) => t?.attributes?.type === 'tool_calls' && t?.attributes?.status === 'pending'
	);
	// A tool call counts as unfinished until its result (or a terminal status)
	// lands: awaiting approval, preparing and executing all count as active.
	const isActiveToolCall = (token: (typeof tokens)[number]) => {
		const attributes = token?.attributes;
		return (
			attributes?.type === 'tool_calls' &&
			attributes.status !== 'rejected' &&
			attributes.status !== 'failed' &&
			attributes.status !== 'incomplete' &&
			attributes.done !== 'true'
		);
	};

	$: hasActiveToolCalls = tokens.some(isActiveToolCall);
	$: hasActiveDetails = tokens.some((token) => {
		const attributes = token?.attributes;
		if (attributes?.type === 'tool_calls') {
			return isActiveToolCall(token);
		}
		return !messageDone && attributes?.done && attributes.done !== 'true';
	});
	$: hasRejected = tokens.some(
		(t) => t?.attributes?.type === 'tool_calls' && t?.attributes?.status === 'rejected'
	);
	// Only the last tool call determines the group's error state: earlier
	// failures that were retried successfully should not show as errors.
	$: lastToolCallFailed = (() => {
		const lastToolCall = tokens.filter((t) => t?.attributes?.type === 'tool_calls').pop();
		if (!lastToolCall) return false;
		return (
			lastToolCall.attributes?.status === 'failed' ||
			(lastToolCall.attributes?.done === 'true' &&
				isToolResultError(decode(lastToolCall.text ?? '')))
		);
	})();

	$: codeInterpreterCount = tokens.filter((t) => t?.attributes?.type === 'code_interpreter').length;

	// Collect all embeds from tool_calls tokens
	$: allEmbeds = (() => {
		if (!allowEmbeds) return [];

		const result: Array<{ name: string; embed: string | MCPAppEmbed; args: string }> = [];
		for (const t of tokens) {
			if (t?.attributes?.type !== 'tool_calls') continue;
			const raw = decode(t.attributes?.embeds ?? '');
			try {
				const parsed = parseJSONString(raw);
				if (Array.isArray(parsed) && parsed.length > 0) {
					for (const embed of parsed) {
						result.push({
							name: t.attributes?.name ?? '',
							embed,
							args: decode(t.attributes?.arguments ?? '')
						});
					}
				}
			} catch {}
		}
		return result;
	})();

	// Agent tool calls read as what they did ("Ran 2 commands · Read 3 files").
	$: actionText = (() => {
		const views = tokens.flatMap((t) => (t?.view ? [t.view] : []));
		if (!views.length) return '';
		const count = (kind: AgentView['kind']) => views.filter((view) => view.kind === kind).length;
		const unique = (paths: string[]) => new Set(paths).size;
		const commands = count('command');
		const edited = unique(
			views.flatMap((view) => (view.kind === 'edit' ? view.files.map((f) => f.path) : []))
		);
		const read = unique(views.flatMap((view) => (view.kind === 'read' ? view.paths : [])));
		const searches = count('search');
		const listed = count('list');
		const webSearches = count('web');
		const fetched = count('fetch');
		const running = new Set(
			tokens.flatMap((t) =>
				t?.view &&
				t.attributes?.done !== 'true' &&
				!['rejected', 'failed', 'incomplete', 'pending', 'queued'].includes(
					t.attributes?.status ?? ''
				)
					? [t.view.kind]
					: []
			)
		);

		const parts = [];
		if (commands)
			parts.push(
				running.has('command')
					? commands === 1
						? $i18n.t('Running 1 command')
						: $i18n.t('Running {{COUNT}} commands', { COUNT: commands })
					: commands === 1
						? $i18n.t('Ran 1 command')
						: $i18n.t('Ran {{COUNT}} commands', { COUNT: commands })
			);
		if (edited)
			parts.push(
				running.has('edit')
					? edited === 1
						? $i18n.t('Editing 1 file')
						: $i18n.t('Editing {{COUNT}} files', { COUNT: edited })
					: edited === 1
						? $i18n.t('Edited 1 file')
						: $i18n.t('Edited {{COUNT}} files', { COUNT: edited })
			);
		if (read)
			parts.push(
				running.has('read')
					? read === 1
						? $i18n.t('Reading 1 file')
						: $i18n.t('Reading {{COUNT}} files', { COUNT: read })
					: read === 1
						? $i18n.t('Read 1 file')
						: $i18n.t('Read {{COUNT}} files', { COUNT: read })
			);
		if (searches)
			parts.push(
				running.has('search')
					? searches === 1
						? $i18n.t('Searching code')
						: $i18n.t('Searching code {{COUNT}} times', { COUNT: searches })
					: searches === 1
						? $i18n.t('Searched code')
						: $i18n.t('Searched code {{COUNT}} times', { COUNT: searches })
			);
		if (listed)
			parts.push(
				running.has('list')
					? listed === 1
						? $i18n.t('Listing 1 directory')
						: $i18n.t('Listing {{COUNT}} directories', { COUNT: listed })
					: listed === 1
						? $i18n.t('Listed 1 directory')
						: $i18n.t('Listed {{COUNT}} directories', { COUNT: listed })
			);
		if (webSearches)
			parts.push(
				running.has('web')
					? webSearches === 1
						? $i18n.t('Searching the web')
						: $i18n.t('Searching the web {{COUNT}} times', { COUNT: webSearches })
					: webSearches === 1
						? $i18n.t('Searched the web')
						: $i18n.t('Searched the web {{COUNT}} times', { COUNT: webSearches })
			);
		if (fetched)
			parts.push(
				running.has('fetch')
					? fetched === 1
						? $i18n.t('Fetching 1 page')
						: $i18n.t('Fetching {{COUNT}} pages', { COUNT: fetched })
					: fetched === 1
						? $i18n.t('Fetched 1 page')
						: $i18n.t('Fetched {{COUNT}} pages', { COUNT: fetched })
			);
		return parts.join(' · ');
	})();

	$: summaryText = (() => {
		const parts = [];

		if (toolCallCount > 0) {
			// Other tools are counted by name.
			const nameCounts: Record<string, number> = {};
			tokens
				.filter((t) => t?.attributes?.type === 'tool_calls' && !t?.view)
				.forEach((t) => {
					const name = t?.attributes?.name ?? 'tool';
					nameCounts[name] = (nameCounts[name] || 0) + 1;
				});

			const toolParts = Object.entries(nameCounts).map(([name, count]) =>
				count > 1 ? `${name} ×${count}` : name
			);
			parts.push(...toolParts);
		}

		if (codeInterpreterCount > 0) {
			if (codeInterpreterCount === 1) {
				parts.push($i18n.t('Ran {{COUNT}} analysis', { COUNT: codeInterpreterCount }));
			} else {
				parts.push($i18n.t('Ran {{COUNT}} analyses', { COUNT: codeInterpreterCount }));
			}
		}

		const detail = parts.join(' · ');
		return detail;
	})();

	// The newest reasoning token in the group, if any.
	$: newestReasoningToken = (() => {
		for (let i = tokens.length - 1; i >= 0; i--) {
			const token = tokens[i];
			if (token?.attributes?.type === 'reasoning') return token;
		}
		return null;
	})();

	// The details header surfaces a preview while that reasoning is still
	// streaming; once the block finishes it falls back to the tool summary so it
	// does not keep echoing a stale thought. Expanding the group hides the preview
	// too, falling back to the tool summary as if there were no preview. The
	// reasoning variant is only used by a process group, which renders once the
	// message is done, so it never previews.
	$: latestReasoningPreview =
		!open && !messageDone && newestReasoningToken?.attributes?.done !== 'true'
			? (newestReasoningToken?.summary ?? '')
			: '';

	// Adopted from upstream/main: the flat label built from the tool calls'
	// display/running labels. It follows the HEAD error semantics
	// (lastToolCallFailed) instead of upstream's hasError, so a retried failure
	// that ends well does not suppress the label.
	$: toolLabels = tokens
		.filter((token) => token.attributes?.type === 'tool_calls')
		.map((token) =>
			['pending', 'queued', 'requires_approval', 'incomplete'].includes(
				token.attributes?.status ?? ''
			)
				? ''
				: toolCallLabel(
						token.attributes,
						token.attributes?.done === 'true',
						token.attributes?.status === 'failed' ||
							(token.attributes?.done === 'true' && isToolResultError(decode(token.text ?? ''))),
						$i18n.t
					)
		);
	$: toolNames = tokens
		.filter((token) => token.attributes?.type === 'tool_calls')
		.map((token) => (token.view ? agentViewName(token.view) : (token.attributes?.name ?? 'tool')));

	// Identical labels collapse with a count ("Generated image ×2"), matching
	// summaryText, so repeated calls don't repeat. First-occurrence order is
	// kept. View calls read as counts of what they did ("Ran 2 commands ·
	// Searched code"), the action summary taking precedence over both the tool
	// labels and the raw view names.
	const collapseCounts = (entries: string[]): string[] => {
		const counts: Record<string, number> = {};
		entries.forEach((entry) => (counts[entry] = (counts[entry] || 0) + 1));
		const seen = new Set<string>();
		return entries
			.filter((entry) => {
				if (seen.has(entry)) return false;
				seen.add(entry);
				return true;
			})
			.map((entry) => (counts[entry] > 1 ? `${entry} ×${counts[entry]}` : entry));
	};
	$: groupLabel = (() => {
		if (
			hasRejected ||
			pendingToolTokens.length > 0 ||
			codeInterpreterCount > 0 ||
			!toolLabels.some(Boolean)
		) {
			return '';
		}

		const toolCallTokens = tokens.filter((token) => token.attributes?.type === 'tool_calls');
		const entries = toolLabels
			.map((label, index) => (toolCallTokens[index]?.view ? '' : label || toolNames[index]))
			.filter(Boolean);

		return [...collapseCounts(entries), actionText].filter(Boolean).join(' · ');
	})();

	// The header's status icon follows this. With "show reasoning summary only"
	// the reasoning is previewed instead of rendered, so the header follows the
	// group's unfinished tool calls and stops spinning once none is left.
	$: groupLive = liveOnActiveToolCalls ? hasActiveToolCalls : groupOpen || hasActiveDetails;

	// A reasoning group never leads with an icon: it renders once its work is
	// done, so the expand chevron stays on the right.
	$: hasLeadingIcon = !isReasoningVariant;
</script>

<div {id} class="w-full min-w-0">
	<div class="flex w-full min-w-0 items-center gap-2">
		<div
			role="button"
			tabindex="0"
			class="group/groupheader {isReasoningVariant
				? 'w-fit'
				: 'flex-1'} min-w-0 py-0.5 text-left {compactPreview
				? 'text-xs'
				: 'text-[0.90625rem]'} text-base-500 hover:text-base-700 dark:hover:text-base-300 transition cursor-pointer"
			aria-label={$i18n.t('Toggle details')}
			aria-expanded={open}
			on:click={() => {
				open = !open;
			}}
			on:keydown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					open = !open;
				}
			}}
		>
			<div class="flex items-center gap-2 min-w-0">
				<!-- Leading: status icon swaps to the expand chevron on hover. -->
				{#if hasLeadingIcon}
					<div class="relative flex size-4 shrink-0 items-center justify-center self-center">
						<div class="flex group-hover/groupheader:invisible">
							{#if groupLive}
								<Spinner className="size-4" />
							{:else if hasRejected}
								<div class="text-red-400 dark:text-red-500">
									<XMark className="size-4" strokeWidth="2.5" />
								</div>
							{:else if toolCallCount > 0 && lastToolCallFailed}
								<div class="text-red-500 dark:text-red-400">
									<XMark className="size-4" strokeWidth="2.5" />
								</div>
							{:else if toolCallCount > 0}
								<div class="text-emerald-500 dark:text-emerald-400">
									<CheckCircle className="size-4" strokeWidth="2" />
								</div>
							{:else}
								<div class="text-base-400 dark:text-base-500">
									<Sparkles className="size-3.5" />
								</div>
							{/if}
						</div>

						<div
							class="absolute inset-0 hidden items-center justify-center group-hover/groupheader:flex text-base-400 dark:text-base-500"
						>
							{#if open}
								<ChevronUp strokeWidth="3.5" className="size-3" />
							{:else}
								<ChevronDown strokeWidth="3.5" className="size-3" />
							{/if}
						</div>
					</div>
				{/if}

				<!-- Summary text: the shimmer follows `groupLive`, the same condition
				     that drives the status icon, so the two can never disagree. -->
				<div class="min-w-0 flex items-center gap-1.5 {isReasoningVariant ? '' : 'flex-1'}">
					{#if isReasoningVariant}
						<span class="min-w-0 truncate">{doneLabel}</span>
					{:else if groupLabel}
						<span
							class="min-w-0 flex-1 truncate text-base-400 dark:text-base-500 transition {groupLive
								? 'shimmer'
								: 'group-hover/groupheader:text-base-700 dark:group-hover/groupheader:text-base-300'}"
							title={summaryText}>{groupLabel}</span
						>
					{:else if latestReasoningPreview}
						<!-- While a reasoning preview is streaming, it replaces the summary
						     entirely so the header stays a single short line. The shimmer
						     follows `groupLive` like the status icon and the other header
						     labels, so a streaming preview shimmers the same way they do. -->
						<span class="min-w-0 flex-1 truncate {groupLive ? 'shimmer' : ''}"
							>{latestReasoningPreview}</span
						>
					{:else if actionText || summaryText}
						<span
							class="min-w-0 flex-1 truncate text-base-500 dark:text-base-400 transition {groupLive
								? 'shimmer'
								: 'group-hover/groupheader:text-base-700 dark:group-hover/groupheader:text-base-300'}"
							>{[actionText, summaryText].filter(Boolean).join(' · ')}</span
						>
					{/if}
				</div>

				{#if resolvable && pendingToolTokens.length === 1 && pendingToolTokens[0]?.attributes?.name !== 'ask_user'}
					{@const pendingCallId = pendingToolTokens[0]?.attributes?.id ?? ''}
					<span class="flex gap-1 shrink-0">
						<button
							type="button"
							class="tool-call-allow-button text-[0.6875rem] px-2.5 py-0.5 rounded-md text-base-600 dark:text-base-300 bg-base-100 dark:bg-base-0/8 hover:bg-base-200 dark:hover:bg-base-0/12 transition-colors duration-100 disabled:opacity-50"
							disabled={!pendingCallId || resolvingCallId === pendingCallId}
							on:click|stopPropagation={() => onResolve(pendingCallId, true)}
						>
							{$i18n.t('Allow')}
						</button>
						<button
							type="button"
							class="tool-call-deny-button text-[0.6875rem] px-2 py-0.5 rounded-md text-base-400 dark:text-base-500 hover:text-base-600 dark:hover:text-base-300 transition-colors duration-100 disabled:opacity-50"
							disabled={!pendingCallId || resolvingCallId === pendingCallId}
							on:click|stopPropagation={() => onResolve(pendingCallId, false)}
						>
							{$i18n.t('Deny')}
						</button>
					</span>
				{:else if !hasLeadingIcon}
					<div class="flex shrink-0 self-center text-base-400 dark:text-base-500">
						{#if open}
							<ChevronUp strokeWidth="3.5" className="size-3" />
						{:else}
							<ChevronDown strokeWidth="3.5" className="size-3" />
						{/if}
					</div>
				{/if}
			</div>
		</div>
	</div>

	{#if !open && resolvable && pendingToolTokens.length > 1}
		<div class="mt-1 space-y-0.5">
			{#each pendingToolTokens as token}
				{@const pendingCallId = token?.attributes?.id ?? ''}
				<div class="flex items-center gap-2 py-1 px-1">
					<span class="text-xs text-base-500 dark:text-base-400 flex-1 min-w-0 line-clamp-1">
						{token?.attributes?.name ?? $i18n.t('tool')}
					</span>
					{#if token?.attributes?.name !== 'ask_user'}
						<span class="flex gap-1 shrink-0">
							<button
								type="button"
								class="tool-call-allow-button text-[0.6875rem] px-2.5 py-0.5 rounded-md text-base-600 dark:text-base-300 bg-base-100 dark:bg-base-0/8 hover:bg-base-200 dark:hover:bg-base-0/12 transition-colors duration-100 disabled:opacity-50"
								disabled={!pendingCallId || resolvingCallId === pendingCallId}
								on:click={() => onResolve(pendingCallId, true)}
							>
								{$i18n.t('Allow')}
							</button>
							<button
								type="button"
								class="tool-call-deny-button text-[0.6875rem] px-2 py-0.5 rounded-md text-base-400 dark:text-base-500 hover:text-base-600 dark:hover:text-base-300 transition-colors duration-100 disabled:opacity-50"
								disabled={!pendingCallId || resolvingCallId === pendingCallId}
								on:click={() => onResolve(pendingCallId, false)}
							>
								{$i18n.t('Deny')}
							</button>
						</span>
					{/if}
				</div>
			{/each}
		</div>
	{/if}

	{#if open}
		<div class="flow-root" transition:expandSlide={{ duration: 300 }}>
			<slot name="content" />
		</div>
	{/if}

	{#if allEmbeds.length > 0}
		{#each allEmbeds as embedItem, idx}
			<div id={`${id}-embed-${idx}`}>
				{#if typeof embedItem.embed === 'object' && embedItem.embed?.type === 'mcp_app'}
					{#key JSON.stringify(embedItem.embed)}{#await import('$lib/components/chat/Messages/MCPApp.svelte') then { default: MCPApp }}<MCPApp
								app={embedItem.embed}
							/>{/await}{/key}
				{:else if typeof embedItem.embed === 'string'}
					<FullHeightIframe
						src={embedItem.embed}
						args={embedItem.args}
						allowScripts={true}
						allowForms={$settings?.iframeSandboxAllowForms ?? false}
						allowSameOrigin={$settings?.iframeSandboxAllowSameOrigin ?? false}
						allowPopups={true}
					/>
				{/if}
			</div>
		{/each}
	{/if}
</div>
