import {
	buildOutputDisplayItems,
	type OutputItem
} from '$lib/components/chat/Messages/structuredOutput';

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

type RailOutputItem = {
	type?: string;
	id?: string;
	content?: unknown;
	[key: string]: unknown;
};

type RailOutputMessage = {
	done?: boolean;
	content?: unknown;
	output?: RailOutputItem[] | null;
	[key: string]: unknown;
};

export type { RailOutputItem, RailOutputMessage };

/**
 * Strips every top-level `<details>…</details>` block (legacy reasoning, tool
 * call and code-interpreter wrappers) from stored message content.
 */
export function stripDetailsBlocks(content: string): string {
	const openTag = '<details';
	const closeTag = '</details>';
	const kept: string[] = [];

	let remaining = content;
	while (remaining) {
		const start = remaining.indexOf(openTag);
		if (start === -1) {
			kept.push(remaining);
			break;
		}

		kept.push(remaining.slice(0, start));

		let depth = 1;
		let index = start + openTag.length;
		while (depth > 0 && index < remaining.length) {
			if (remaining.startsWith(openTag, index)) depth++;
			else if (remaining.startsWith(closeTag, index)) depth--;
			if (depth > 0) index++;
		}

		if (depth === 0) {
			remaining = remaining.slice(index + closeTag.length);
			// The block is followed by a line break in storage; drop it too so the
			// plain content before and after joins without a stray blank line.
			if (remaining.startsWith('\n')) remaining = remaining.slice(1);
		} else {
			// Unmatched opening tag: keep the rest as plain text.
			kept.push(remaining.slice(start));
			remaining = '';
		}
	}

	return kept.join('');
}

/**
 * The markdown-only response shown in the rail preview: every `message` output
 * item that is NOT wrapped in a process group. Narrated messages join the
 * process group once the reply is done, so while it streams (or when the run
 * holds no groupable detail at all) all message items show up; tool calls,
 * reasoning, code runs, files and compaction markers are excluded either way.
 * Legacy content falls back to the stored markdown with `<details>` blocks
 * stripped.
 */
export function collectRailResponseParts(message: RailOutputMessage | null | undefined): string[] {
	if (!message) return [];

	if (Array.isArray(message.output) && message.output.length > 0) {
		const displayItems = buildOutputDisplayItems(
			message.output as OutputItem[],
			false,
			message.done !== false
		);
		const parts: string[] = [];
		for (const item of displayItems) {
			if (item.type === 'message' && item.text?.trim()) parts.push(item.text);
		}
		return parts;
	}

	if (typeof message.content === 'string' && message.content.trim()) {
		const stripped = stripDetailsBlocks(message.content);
		if (stripped.trim()) return [stripped];
	}

	return [];
}
