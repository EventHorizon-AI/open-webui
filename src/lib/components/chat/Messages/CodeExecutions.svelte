<script lang="ts">
	import { getContext } from 'svelte';
	import CodeExecutionModal from './CodeExecutionModal.svelte';
	import Spinner from '$lib/components/common/Spinner.svelte';
	import Check from '$lib/components/icons/Check.svelte';
	import XMark from '$lib/components/icons/XMark.svelte';
	import EllipsisHorizontal from '$lib/components/icons/EllipsisHorizontal.svelte';

	import Collapsible from '$lib/components/common/Collapsible.svelte';
	import ChevronDown from '$lib/components/icons/ChevronDown.svelte';
	import ChevronUp from '$lib/components/icons/ChevronUp.svelte';

	const i18n = getContext('i18n');

	export let codeExecutions = [];

	let selectedCodeExecution = null;
	let showCodeExecutionModal = false;
	let isCollapsibleOpen = false;

	$: if (codeExecutions) {
		updateSelectedCodeExecution();
	}

	const updateSelectedCodeExecution = () => {
		if (selectedCodeExecution) {
			selectedCodeExecution = codeExecutions.find(
				(execution) => execution.id === selectedCodeExecution.id
			);
		}
	};
</script>

<CodeExecutionModal bind:show={showCodeExecutionModal} codeExecution={selectedCodeExecution} />

{#if codeExecutions.length > 0}
	<div class="py-0.5 -mx-0.5 w-full flex gap-1 items-center flex-wrap">
		{#if codeExecutions.length <= 3}
			<div class="flex text-xs font-medium flex-wrap">
				{#each codeExecutions as execution, idx (execution.id)}
					<button
						class="no-toggle outline-hidden flex dark:text-gray-300 p-1 bg-white hover:bg-gray-100 dark:bg-gray-900 dark:hover:bg-gray-850 transition rounded-xl max-w-96"
						on:click={() => {
							selectedCodeExecution = execution;
							showCodeExecutionModal = true;
						}}
					>
						<div class="bg-gray-50 dark:bg-gray-800 rounded-full size-4 flex items-center justify-center">
							{#if execution?.result}
								{#if execution.result?.error}
									<XMark />
								{:else if execution.result?.output}
									<Check strokeWidth="3" className="size-3" />
								{:else}
									<EllipsisHorizontal />
								{/if}
							{:else}
								<Spinner className="size-3" />
							{/if}
						</div>
						<div class="flex-1 mx-1 truncate text-black/60 hover:text-black dark:text-white/60 dark:hover:text-white transition {execution?.result ? '' : 'pulse'}">
							{execution.name}
						</div>
					</button>
				{/each}
			</div>
		{:else}
			<Collapsible
				id="collapsible-code-executions"
				bind:open={isCollapsibleOpen}
				className="w-full max-w-full"
				buttonClassName="w-fit max-w-full"
			>
				<div
					class="flex w-full overflow-auto items-center gap-2 text-gray-500 hover:text-gray-600 dark:hover:text-gray-400 transition cursor-pointer"
				>
					<div class="flex-1 flex items-center gap-1 overflow-auto scrollbar-none w-full max-w-full">
						<span class="whitespace-nowrap hidden sm:inline shrink-0"
							>{$i18n.t('Code Execution')}</span
						>
						<div class="flex items-center overflow-auto scrollbar-none w-full max-w-full flex-1">
							<div class="flex text-xs font-medium items-center">
								{#each codeExecutions.slice(0, 2) as execution, idx (execution.id)}
									<button
										class="no-toggle outline-hidden flex dark:text-gray-300 p-1 bg-gray-50 hover:bg-gray-100 dark:bg-gray-900 dark:hover:bg-gray-850 transition rounded-xl max-w-96"
										on:click={() => {
											selectedCodeExecution = execution;
											showCodeExecutionModal = true;
										}}
										on:pointerup={(e) => e.stopPropagation()}
									>
										<div class="bg-gray-50 dark:bg-gray-800 rounded-full size-4 flex items-center justify-center">
											{#if execution?.result}
												{#if execution.result?.error}
													<XMark />
												{:else if execution.result?.output}
													<Check strokeWidth="3" className="size-3" />
												{:else}
													<EllipsisHorizontal />
												{/if}
											{:else}
												<Spinner className="size-3" />
											{/if}
										</div>
										<div class="flex-1 mx-1 truncate">
											{execution.name}
										</div>
									</button>
								{/each}
							</div>
						</div>
						<div class="flex items-center gap-1 whitespace-nowrap shrink-0">
							<span class="hidden sm:inline">{$i18n.t('and')}</span>
							{codeExecutions.length - 2}
							<span>{$i18n.t('more')}</span>
						</div>
					</div>
					<div class="shrink-0">
						{#if isCollapsibleOpen}
							<ChevronUp strokeWidth="3.5" className="size-3.5" />
						{:else}
							<ChevronDown strokeWidth="3.5" className="size-3.5" />
						{/if}
					</div>
				</div>
				<div slot="content">
					<div class="flex text-xs font-medium flex-wrap">
						{#each codeExecutions.slice(2) as execution, idx (execution.id)}
							<button
								class="no-toggle outline-hidden flex dark:text-gray-300 p-1 bg-gray-50 hover:bg-gray-100 dark:bg-gray-900 dark:hover:bg-gray-850 transition rounded-xl max-w-96"
								on:click={() => {
									selectedCodeExecution = execution;
									showCodeExecutionModal = true;
								}}
							>
								<div class="bg-gray-50 dark:bg-gray-800 rounded-full size-4 flex items-center justify-center">
									{#if execution?.result}
										{#if execution.result?.error}
											<XMark />
										{:else if execution.result?.output}
											<Check strokeWidth="3" className="size-3" />
										{:else}
											<EllipsisHorizontal />
										{/if}
									{:else}
										<Spinner className="size-3" />
									{/if}
								</div>
								<div class="flex-1 mx-1 truncate">
									{execution.name}
								</div>
							</button>
						{/each}
					</div>
				</div>
			</Collapsible>
		{/if}
	</div>
{/if}

<style>
	@keyframes pulse {
		0%,
		100% {
			opacity: 1;
		}
		50% {
			opacity: 0.6;
		}
	}

	.pulse {
		opacity: 1;
		animation: pulse 1.5s ease;
	}
</style>
