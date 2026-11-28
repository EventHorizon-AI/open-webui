<script lang="ts">
	import hljs from 'highlight.js';
	import 'highlight.js/styles/github-dark.min.css';

	export let code = '';
	export let lang = '';

	// code-delta: appended text usually only extends the highlighted output, so
	// keep the existing DOM nodes for the unchanged prefix and append just the
	// new suffix. A full innerHTML swap (rebuilding every highlight node)
	// happens only when the highlighting of earlier content actually changed,
	// which is rare while a code block streams. The rendered result is
	// identical either way; this only avoids redundant DOM churn.
	let lastHtml = '';
	let lastText: string | null = null;
	let lastPlain = false;
	const applyCode = (node: HTMLElement, params: { html: string | null; plain: string }) => {
		const render = (html: string | null, plain: string) => {
			if (html === null) {
				if (!lastPlain || lastText !== plain) {
					node.textContent = plain;
					lastPlain = true;
					lastText = plain;
					lastHtml = '';
				}
				return;
			}
			if (lastPlain || html !== lastHtml) {
				if (!lastPlain && html.startsWith(lastHtml)) {
					node.insertAdjacentHTML('beforeend', html.slice(lastHtml.length));
				} else {
					node.innerHTML = html;
				}
				lastPlain = false;
				lastText = null;
				lastHtml = html;
			}
		};
		render(params.html, params.plain);
		return {
			update(next: { html: string | null; plain: string }) {
				render(next.html, next.plain);
			}
		};
	};

	$: lineCount = countLines(code);
	$: gutterWidth = `${String(lineCount).length + 1}ch`;
	$: canHighlight = !!lang && hljs.getLanguage(lang);
	$: highlighted = canHighlight
		? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
		: null;

	function countLines(text: string): number {
		let count = 1;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) count++;
		}
		return count;
	}
</script>

<div class="code-preview" dir="ltr">
	<div class="gutter" aria-hidden="true" style:--gutter-width={gutterWidth}>
		{#each { length: lineCount } as _, index}
			<span class="number">{index + 1}</span>
		{/each}
	</div>
	<pre><code
			class={lang ? `language-${lang}` : undefined}
			use:applyCode={{ html: highlighted, plain: code }}></code></pre>
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
		/* deliberately no z-index: keeps the gutter above scrolled code content via
		   positioning alone, while staying below positioned overlays of ancestors
		   (e.g. the collapsed-message fade) so it fades like the rest of the code */
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
