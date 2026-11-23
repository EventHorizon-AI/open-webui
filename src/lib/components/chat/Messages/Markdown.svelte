<script context="module">
	import { marked } from 'marked';

	import markedExtension from '$lib/utils/marked/extension';
	import markedKatexExtension from '$lib/utils/marked/katex-extension';
	import { disableSingleTilde } from '$lib/utils/marked/strikethrough-extension';
	import { mentionExtension } from '$lib/utils/marked/mention-extension';
	import colonFenceExtension from '$lib/utils/marked/colon-fence-extension';
	import footnoteExtension from '$lib/utils/marked/footnote-extension';
	import citationExtension from '$lib/utils/marked/citation-extension';
	import cjkFriendlyExtension from '$lib/utils/marked/cjk-friendly-extension';

	const options = {
		throwOnError: false
	};

	marked.use(markedKatexExtension(options));
	marked.use(markedExtension(options));
	marked.use(citationExtension(options));
	marked.use(footnoteExtension(options));
	marked.use(colonFenceExtension(options));
	marked.use(cjkFriendlyExtension());
	marked.use(disableSingleTilde);
	// Also set by RichTextInput, but messages can render before any input mounts.
	marked.use({ breaks: true });
	marked.use({
		extensions: [
			mentionExtension({ triggerChar: '@' }),
			mentionExtension({ triggerChar: '#' }),
			mentionExtension({ triggerChar: '$' })
		]
	});
</script>

<script>
	import { onDestroy, setContext } from 'svelte';
	import { replaceTokens, processResponseContent } from '$lib/utils';
	import { user } from '$lib/stores';

	import MarkdownTokens from './Markdown/MarkdownTokens.svelte';

	export let id = '';
	export let chatId = '';
	export let messageId = '';
	export let content;
	export let done = true;
	export let model = null;
	export let save = false;
	export let preview = false;
	export let compactPreview = false;

	export let paragraphTag = 'p';
	export let editCodeBlock = true;
	export let topPadding = false;
	export let allowEmbeds = false;
	export let allowHtml = true;
	export let allowRemoteContent = true;

	setContext('markdown', {
		get allowRemoteContent() {
			return allowRemoteContent;
		}
	});

	export let sourceIds = [];

	export let onSave = () => {};
	export let onUpdate = () => {};

	export let onPreview = () => {};

	export let onSourceClick = () => {};
	export let onTaskClick = () => {};
	export let onToolCallResolved = () => {};

	let tokens = [];
	let pendingUpdate = null;
	let lastContent = '';
	let lastParsedContent = '';
	let hasParsed = false;

	// --- incremental lexing (streaming) ---
	// Lexing the full text every frame costs O(message length), so long replies
	// degrade the longer they stream. Markdown block structure only changes at
	// blank lines that sit safely outside open constructs (code fence, math,
	// colon fence, details), so the tokens before the last such boundary are
	// reused verbatim and only the tail is re-lexed. Anything uncertain falls
	// back to a full lex, and `done` always re-lexes everything for the final
	// render.
	let stableTokens = [];
	let stableSource = '';
	let scanner = null;

	const createScanner = () => ({
		pos: 0,
		boundary: 0,
		prevBoundary: 0,
		fence: null,
		mathParity: 0,
		colonFence: false,
		detailsDepth: 0,
		// Whether `pos` starts a fresh line. A stream frame can end mid-line (no
		// trailing newline yet); the newline that later terminates that line
		// must not be mistaken for a blank line, or the boundary would jump
		// into the middle of the growing block (tables stop growing until the
		// full re-lex at done).
		atLineStart: true
	});

	const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;
	const FENCE_CLOSE_RE = /^ {0,3}(?:`{3,}|~{3,})\s*$/;
	const COLON_OPEN_RE = /^ {0,3}:::/;
	const COLON_CLOSE_RE = /^ {0,3}:::\s*$/;
	// A blank line followed by these starts a new block, but the construct before
	// it may still be the same one (loose list items, quote paragraphs, indented
	// code / footnote continuation): never split there.
	const CONTINUATION_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])\s|^ {0,3}>|^ {4}/;

	const findStableBoundary = (text) => {
		if (!scanner || !text.startsWith(stableSource)) {
			scanner = createScanner();
			stableSource = '';
			stableTokens = [];
		}
		const s = scanner;
		while (s.pos < text.length) {
			if (text[s.pos] === '\n') {
				if (s.atLineStart) {
					// A genuinely empty line between two newlines.
					if (s.fence === null && !s.colonFence && !s.mathParity && s.detailsDepth === 0) {
						const boundary = s.pos + 1;
						if (boundary !== s.boundary) {
							s.prevBoundary = s.boundary;
							s.boundary = boundary;
						}
					}
					s.pos += 1;
					continue;
				}
				// Terminates the line a previous frame left open.
				s.pos += 1;
				s.atLineStart = true;
				continue;
			}
			const nl = text.indexOf('\n', s.pos);
			const lineEnd = nl === -1 ? text.length : nl;
			const line = text.slice(s.pos, lineEnd);
			if (s.fence !== null) {
				if (FENCE_CLOSE_RE.test(line)) s.fence = null;
			} else if (s.colonFence) {
				if (COLON_CLOSE_RE.test(line)) s.colonFence = false;
			} else if (s.mathParity) {
				s.mathParity ^= (line.match(/\$\$/g) ?? []).length & 1;
			} else {
				if (FENCE_OPEN_RE.test(line)) {
					s.fence = (line.match(FENCE_OPEN_RE) ?? [])[1]?.[0] ?? '`';
				} else if (COLON_OPEN_RE.test(line)) {
					s.colonFence = true;
				} else {
					s.mathParity ^= (line.match(/\$\$/g) ?? []).length & 1;
				}
				s.detailsDepth +=
					(line.match(/<details[\s>]/gi) ?? []).length - (line.match(/<\/details>/gi) ?? []).length;
				if (s.detailsDepth < 0) s.detailsDepth = 0;
			}
			if (nl !== -1) {
				if (
					line.trim() === '' &&
					s.fence === null &&
					!s.colonFence &&
					!s.mathParity &&
					s.detailsDepth === 0
				) {
					const boundary = lineEnd + 1;
					if (boundary !== s.boundary) {
						s.prevBoundary = s.boundary;
						s.boundary = boundary;
					}
				}
				s.pos = lineEnd + 1;
				s.atLineStart = true;
			} else {
				s.pos = text.length;
				// The line is still open: a newline may arrive in the next frame.
				s.atLineStart = false;
			}
		}
		return s;
	};

	const parseTokens = () => {
		if (content === lastContent) return;
		lastContent = content;

		const processed = replaceTokens(processResponseContent(content), model?.name, $user?.name);
		if (processed === lastParsedContent) return;

		let nextTokens = null;
		if (!done) {
			try {
				findStableBoundary(processed);
				const boundary = scanner.boundary;
				const tail = processed.slice(boundary);
				if (
					boundary > 0 &&
					tail.length > 0 &&
					!CONTINUATION_RE.test(tail) &&
					boundary >= stableSource.length
				) {
					// Extend the stable prefix with any newly settled region
					// (usually empty; the boundary only moves on paragraph ends).
					const delta = processed.slice(stableSource.length, boundary);
					if (delta) {
						stableTokens = [...stableTokens, ...marked.lexer(delta)];
						stableSource = processed.slice(0, boundary);
					}
					nextTokens = [...stableTokens, ...marked.lexer(tail)];
				}
			} catch {
				nextTokens = null;
			}
		}

		if (nextTokens === null) {
			// Full lex: done, or no safe split was found this frame.
			nextTokens = marked.lexer(processed);
			stableTokens = [];
			stableSource = '';
			scanner = createScanner();
		}
		lastParsedContent = processed;
		tokens = nextTokens;

		if (!allowHtml || !allowRemoteContent) {
			marked.walkTokens(tokens, (token) => {
				if (
					(!allowHtml && token.type === 'html') ||
					(!allowRemoteContent &&
						['html', 'image', 'iframe', 'mention', 'details', 'colonFence'].includes(token.type))
				) {
					const raw = token.raw;
					// Drop child tokens too, so blocked content cannot render through a nested renderer.
					for (const key of Object.keys(token)) Reflect.deleteProperty(token, key);
					Object.assign(token, { type: 'text', raw, text: raw });
				}
			});
		}
	};

	const updateHandler = (content) => {
		if (content) {
			// The first parse runs synchronously. A disclosure that mounts with
			// already-streamed text must expose its real height in the same frame,
			// otherwise an expand transition measures an empty body and clips
			// everything that appears after it until the animation ends. Only
			// follow-up updates are throttled to one per animation frame.
			if (done || !hasParsed) {
				cancelAnimationFrame(pendingUpdate);
				pendingUpdate = null;
				parseTokens();
				hasParsed = true;
			} else if (!pendingUpdate) {
				pendingUpdate = requestAnimationFrame(() => {
					pendingUpdate = null;
					parseTokens();
				});
			}
		}
	};

	$: updateHandler(content);

	// Throttle parsing to once per animation frame while streaming
	onDestroy(() => {
		cancelAnimationFrame(pendingUpdate);
	});
</script>

{#key id}
	<MarkdownTokens
		{tokens}
		{id}
		{chatId}
		{messageId}
		{done}
		{save}
		{preview}
		{compactPreview}
		{paragraphTag}
		{editCodeBlock}
		{sourceIds}
		{topPadding}
		{allowEmbeds}
		{onTaskClick}
		{onSourceClick}
		{onToolCallResolved}
		{onSave}
		{onUpdate}
		{onPreview}
	/>
{/key}
