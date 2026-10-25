const EXCERPT_TAGS = new Set([
	'P',
	'BR',
	'STRONG',
	'B',
	'EM',
	'I',
	'S',
	'DEL',
	'CODE',
	'PRE',
	'UL',
	'OL',
	'LI',
	'BLOCKQUOTE',
	'TABLE',
	'THEAD',
	'TBODY',
	'TR',
	'TH',
	'TD'
]);

const SKIPPED_SELECTOR =
	'script,style,iframe,object,embed,svg,canvas,img,video,audio,button,input,textarea,select,details,[hidden],[aria-hidden="true"],.hidden,.sr-only';

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * Rebuild a small, formatting-only copy of rendered message content. Links,
 * media, scripts, event handlers and other attributes never enter the result.
 */
export function buildExcerptHtml(source: Element | null, maxLength = 1200): string {
	if (!source) return '';

	let remaining = maxLength;
	let visited = 0;
	const parts: string[] = [];

	const copy = (node: Node, depth: number) => {
		if (remaining <= 0 || visited > 500 || depth > 24) return;

		if (node.nodeType === Node.TEXT_NODE) {
			const text = (node.textContent ?? '').slice(0, remaining);
			remaining -= text.length;
			parts.push(escapeHtml(text));
			return;
		}

		if (node.nodeType !== Node.ELEMENT_NODE) return;

		const element = node as Element;
		if (element.matches(SKIPPED_SELECTOR)) return;

		visited += 1;

		if (element.matches('.cm-editor')) {
			const lines: string[] = [];
			for (const line of element.querySelectorAll('.cm-content .cm-line')) {
				if (remaining <= 0 || visited > 500) break;
				visited += 1;
				const text = (line.textContent ?? '').slice(0, remaining);
				remaining -= text.length;
				lines.push(text);
			}
			parts.push(`<pre><code>${escapeHtml(lines.join('\n'))}</code></pre>`);
			return;
		}

		const tag = EXCERPT_TAGS.has(element.tagName)
			? element.tagName.toLowerCase()
			: /^H[1-6]$/.test(element.tagName)
				? 'h3'
				: '';

		if (!tag) {
			for (const child of element.childNodes) {
				copy(child, depth + 1);
				if (remaining <= 0 || visited > 500) break;
			}
			return;
		}

		if (tag === 'br') {
			parts.push('<br>');
			return;
		}

		parts.push(`<${tag}>`);
		for (const child of element.childNodes) {
			copy(child, depth + 1);
			if (remaining <= 0 || visited > 500) break;
		}
		parts.push(`</${tag}>`);
	};

	copy(source, 0);
	if (remaining <= 0 || visited > 500) parts.push('…');

	return parts.join('');
}

export function excerptText(html: string): string {
	if (typeof document === 'undefined' || !html) return '';

	const template = document.createElement('template');
	template.innerHTML = html;
	return (template.content.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function truncateText(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
