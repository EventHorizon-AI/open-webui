<script lang="ts">
	import hljs from 'highlight.js';
	import 'highlight.js/styles/github-dark.min.css';

	export let code = '';
	export let lang = '';

	$: lines = code.length > 0 ? code.split('\n') : [''];
	$: gutterWidth = `${String(lines.length).length + 1}ch`;
	$: highlighted =
		lang && hljs.getLanguage(lang)
			? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
			: code;
</script>

<div class="code-preview text-sm" dir="ltr" style:--gutter-width={gutterWidth}>
	<div class="line-numbers" aria-hidden="true">
		{#each lines as _, index}
			<span>{index + 1}</span>
		{/each}
	</div>
	<pre><code class="language-{lang}">{@html highlighted}</code></pre>
</div>

<style>
	.code-preview {
		display: flex;
		align-items: stretch;
		overflow-x: auto;
		background: #0d1117;
		color: #c9d1d9;
		width: 100%;
		font-family: var(--font-mono, ui-monospace, monospace);
	}

	.line-numbers {
		flex: 0 0 auto;
		display: flex;
		flex-direction: column;
		padding: 0.5rem 0;
		min-width: var(--gutter-width);
		background: #0d1117;
		color: #6e7781;
		border-inline-end: 1px solid #30363d;
		user-select: none;
	}

	.line-numbers span {
		padding: 0 0.75rem;
		text-align: right;
		line-height: 1.6;
	}

	pre {
		flex: 0 0 auto;
		margin: 0;
		padding: 0.5rem 1rem;
		background: transparent;
		color: inherit;
		border-radius: 0;
		font-size: inherit;
		line-height: 1.6;
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

	:global(.dark) .code-preview,
	:global(.dark) .line-numbers {
		background: #0d1117;
	}
</style>
