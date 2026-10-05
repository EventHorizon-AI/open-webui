<script lang="ts">
	import hljs from 'highlight.js';
	import 'highlight.js/styles/github-dark.min.css';

	export let code = '';
	export let lang = '';

	$: lines = code.length > 0 ? code.split('\n') : [''];

	$: gutterWidth = `${String(lines.length).length + 1}ch`;

	$: canHighlight = !!lang && hljs.getLanguage(lang);

	$: highlighted = canHighlight
		? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
		: null;
</script>

<div class="code-preview" dir="ltr">
	<div class="gutter" aria-hidden="true" style:--gutter-width={gutterWidth}>
		{#each lines as _, index}
			<span class="number">{index + 1}</span>
		{/each}
	</div>
	<pre><code class={lang ? `language-${lang}` : undefined}
			>{#if highlighted !== null}{@html highlighted}{:else}{code}{/if}</code
		></pre>
</div>

<style>
	.code-preview {
		display: flex;
		align-items: stretch;
		width: 100%;
		overflow-x: auto;
		background: #ffffff;
		color: #1f2328;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		font-size: 0.916667em;
		line-height: 1.636364;
	}

	.gutter {
		position: sticky;
		left: 0;
		z-index: 1;
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		min-width: var(--gutter-width);
		padding: 0.5rem 0;
		background: #ffffff;
		user-select: none;
	}

	.number {
		padding: 0 0.5rem;
		text-align: right;
		color: #6e7781;
		border-right: 1px solid rgb(0 0 0 / 0.05);
	}

	pre {
		flex: 0 0 auto;
		margin: 0;
		padding: 0.5rem 1rem 0.5rem 0.5rem;
		background: transparent;
		color: inherit;
		border-radius: 0;
		font: inherit;
		font-family: inherit;
		line-height: inherit;
		white-space: pre;
		tab-size: 4;
	}

	code {
		display: block;
		padding: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-family: inherit;
		white-space: pre;
	}

	:global(.dark) .code-preview {
		background: #000000;
		color: #c9d1d9;
	}

	:global(.dark) .gutter {
		background: #000000;
	}

	:global(.dark) .number {
		border-color: rgb(255 255 255 / 0.04);
	}
</style>
