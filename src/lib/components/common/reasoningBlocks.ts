/**
 * Display blocks for a reasoning body.
 *
 * The reasoning is rendered block by block instead of as one streamed document.
 * Blocks are sized in tokens with a deliberately simple tokenizer (two CJK
 * characters count one token, other runs about one token per four characters):
 * once a block reaches `REASONING_BLOCK_TOKEN_TARGET` tokens it is cut at the
 * next blank line, so blocks end at paragraph boundaries and appear in one piece
 * instead of growing character by character. While the reasoning is still
 * streaming the trailing block — including the line being written, which has no
 * newline yet — is withheld until it completes. A block's body (after
 * its title is carved out) renders as plain text: its markdown markers are
 * removed, fenced code blocks are dropped whole and its lines are joined with
 * spaces. It shows at most `REASONING_BLOCK_TOKEN_LIMIT` tokens; the rest is
 * folded behind an ellipsis.
 *
 * Every block also gets a title derived from its own text with pure JS (no
 * model call): an explicit heading, a bold label or a bold `Label:` lead when
 * the block has one, otherwise the block's opening sentence up to the first
 * full stop with the words that do not carry its topic removed — each term is
 * weighted by how often the block uses it (tf) and how rare it is among the
 * reasoning's sentences (idf), and framing, glue and one-off fragments are
 * deleted. "嗯，用户想写一个递归函数来逆序句子中的单词，同时还要排除非字母字符"
 * therefore titles as "递归逆序句子单词，排除字母字符". When the pruning
 * cannot produce a title, the plain lead is used instead: the block's opening,
 * counted in tokens the same way blocks are cut, ended at the next punctuation
 * once `REASONING_BLOCK_TITLE_TOKEN_TARGET` tokens are reached, and distilled
 * down to its main content — filler words are removed (一些, "some"), and the
 * framing preamble (sequencing words, the asker "用户要求…"/"the user wants
 * to…" and first-person lead-ins "我需要…"/"I need to…") is stripped. An
 * English lead then drops its function words (articles, the dummy object "it",
 * the infinitive "to", copulas and auxiliaries): "Rewrite the function to make
 * it easier to analyze" becomes "Rewrite function make easier analyze". A block
 * that holds only its title — nothing follows the lead — renders without one
 * instead of splitting itself in half. The title keeps the text's own casing.
 * The title is carved out of the block and the block renders as `**{title}**`
 * followed by the remaining text; a title wider than the display-width cap is
 * cut at a word or clause boundary with an ellipsis.
 */

/** Tokens a block may hold before it is cut at the next newline. */
export const REASONING_BLOCK_TOKEN_TARGET = 300;

/** Tokens of a block's body that stay visible before it is cut with an ellipsis. */
export const REASONING_BLOCK_TOKEN_LIMIT = 40;

/**
 * Tokens a title may reach before it is cut at the next comma; the cut-off part
 * is dropped.
 */
export const REASONING_BLOCK_TITLE_TOKEN_TARGET = 8;

/**
 * Width at which a title is cut, in half-width display units: roughly 40
 * Chinese characters or 80 English ones. A long, comma-less lead — "The
 * function should first split the input sentence into individual words while
 * keeping every piece of punctuation attached…" — is where this fires in
 * practice.
 */
export const REASONING_BLOCK_TITLE_MAX_WIDTH = 80;

/** A title shorter than this is skipped and the next sentence is tried. */
const TITLE_MIN_CHARS = 2;

// Characters that occupy two half-width cells in a monospace-like layout.
const WIDE_CLASS =
	'\\u1100-\\u115F\\u2E80-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE10-\\uFE19\\uFE30-\\uFE6F\\uFF00-\\uFF60\\uFFE0-\\uFFE6';

const WIDE_CHAR_RE = new RegExp(`[${WIDE_CLASS}]`, 'u');

// Deliberately simple tokenizer: two wide (CJK, Kana, Hangul, full-width)
// characters count one token, and any other run of non-space characters about
// one token per four characters — the way byte-pair merges usually settle. It
// sizes display blocks; it does not have to reproduce a model's vocabulary.
const WIDE_CHARS_PER_TOKEN = 2;
const NARROW_CHARS_PER_TOKEN = 4;

const TOKEN_RE = new RegExp(`([${WIDE_CLASS}]+)|([^\\s${WIDE_CLASS}]+)`, 'gu');

const charWidth = (char: string) => (WIDE_CHAR_RE.test(char) ? 2 : 1);

function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		width += charWidth(char);
	}
	return width;
}

type TokenPiece = {
	/** Index just past the piece in the source text. */
	end: number;
	/** Character length of the piece. */
	size: number;
	/** Tokens this piece counts as. */
	tokens: number;
	/** Characters of this piece that make up one token. */
	charsPerToken: number;
};

function* tokenPieces(text: string): Generator<TokenPiece> {
	for (const match of text.matchAll(TOKEN_RE)) {
		const piece = match[0];
		const charsPerToken = match[1] ? WIDE_CHARS_PER_TOKEN : NARROW_CHARS_PER_TOKEN;
		yield {
			end: (match.index ?? 0) + piece.length,
			size: piece.length,
			tokens: Math.ceil(piece.length / charsPerToken),
			charsPerToken
		};
	}
}

/** Tokens in `text`, using the simple tokenizer. */
export function countReasoningTokens(text: string): number {
	let count = 0;
	for (const piece of tokenPieces(text)) {
		count += piece.tokens;
	}
	return count;
}

/**
 * Cuts `text` at a token boundary so it holds at most `tokenLimit` tokens,
 * appending an ellipsis when anything was dropped. The last partial piece keeps
 * the characters that fit, so a single long run is never reduced to just the
 * ellipsis.
 */
export function truncateReasoningTokens(
	text: string,
	tokenLimit: number
): { text: string; truncated: boolean } {
	let count = 0;
	let end = 0;

	for (const piece of tokenPieces(text)) {
		if (count + piece.tokens > tokenLimit) {
			const remaining = tokenLimit - count;
			// A piece with more than one token is a run of characters: keep the
			// characters that fit so the cut is not empty.
			if (remaining > 0) {
				end = piece.end - piece.size + Math.min(piece.size, remaining * piece.charsPerToken);
			}
			return { text: `${text.slice(0, end).trimEnd()}…`, truncated: true };
		}

		count += piece.tokens;
		end = piece.end;
	}

	return { text, truncated: false };
}

export type ReasoningBlock = {
	/** Derived title, or '' when the block is its own title. */
	title: string;
	/** Markdown to render: `**title**\ncontent`, or just the content without one. */
	text: string;
	/** Whether the body was cut at the token limit. */
	truncated: boolean;
};

export type BuildReasoningBlocksOptions = {
	/**
	 * Drop the trailing block that is not yet complete. Set while the reasoning
	 * is still streaming: the block has not reached a blank-line cut yet.
	 */
	streaming?: boolean;
	/** Tokens a block accumulates before it is cut at the next blank line. */
	tokenTarget?: number;
	/** Tokens a block's body may show before it is cut with an ellipsis. */
	tokenLimit?: number;
};

type TitleCandidate = {
	title: string;
	consumed: number;
	/**
	 * Material in front of the title was lifted out while the title was
	 * derived, so the body keeps the original text instead of skipping it.
	 */
	leadStripped: boolean;
};

const NO_TITLE: TitleCandidate = { title: '', consumed: 0, leadStripped: false };

const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s+\S/;

// Conversational openers that make poor titles ("Okay, ...", "好的，..."). Only
// stripped when followed by punctuation, so ordinary words are kept ("对于",
// "well-formed").
const LEAD_FILLER_RE =
	/^(?:(?:okay|ok|sure|alright|yeah|yes|well|so|hmm+|hm+|好的|好吧|好|嗯+|呃+|是的|对的|没错|没问题|明白了|明白|可以)\s*[,，、.。!！?？;；:：~～]+\s*)+/i;

// Preamble phrases a title does not need, stripped repeatedly so nested
// framing unwinds ("好的，用户要求搜索…" -> "搜索…"): sequencing words ("首先",
// "Next,"), the asker framing the request ("用户要求…", "the user wants to…")
// and first-person lead-ins ("我需要…", "I need to…", "let me…"). What remains
// is the task itself, e.g. "用户要求搜索 OpenAI 的新闻" -> "搜索 OpenAI 的新闻".
const TITLE_PREAMBLE_RES: RegExp[] = [
	// Chinese sequencing words.
	/^(?:首先|其次|然后|接着|接下来|之后|最后|现在|那么|所以|因此|另外|此外|同时|进一步|再次|再)[，,]?\s*/,
	// Pointless lead-ins: 需要注意的是，缓存… -> 缓存…, 关键的一点是… -> …
	/^(?:最?重要|需要|值得|重点|关键|问题|结论)(?:注意|说明|强调|指出|留意|关注)?(?:的?(?:一点|地方|之处))?(?:的)?(?:是|在于|就是)[，,]?\s*/,
	// Someone asking for something: 用户要求搜索… -> 搜索…, including the cleft
	// form that ends in 的是: 用户询问的是关于… -> 关于…; the bare 问/说 (问的是,
	// 说到了) are kept from eating nouns by their guards, and 想 may carry its
	// known verb (想知道, 想了解).
	/^(?:用户|我|我们|咱们|你|你们|他|她|他们|它)(?:要求|请求|希望|想要|想(?:要)?(?:知道|了解|问)?|需要|要|让|叫|请|询问|问(?!题)(?:到|过|了)*|说(?!明|法|服)(?:到|过|了)*|打算|准备|计划|应该|应当|必须|可以|得(?!出)|将|会(?!议|话)|来)(?:我|我们|你|他们)?(?:的|地)?(?:是)?/,
	// The asker's question named as a noun: 用户的问题是X -> X.
	/^(?:用户|我|我们|咱们|你|你们|他|她|他们|它)(?:的)?(?:问题|疑问|目标|需求|任务|目的|意图|诉求|请求|计划)(?:是|在于|就是|是想)[，,]?\s*/,
	// 让我看看… / 让我们试试… without a subject.
	/^让我们?/,
	// Bare modals: 需要检查… -> 检查…; 得 is guarded so 得出结论 is kept.
	/^(?:还要?|需要|应该|应当|必须|得(?!出)|打算)/,
	// Hedges: 我觉得缓存有问题 -> 缓存有问题.
	/^(?:我)?(?:觉得|认为|猜测|推断|估计|发现|注意到|意识到|看到|明白|理解)/,
	// English sequencing words.
	/^(?:first|firstly|second|secondly|third|then|next|now|finally|lastly|also|so|well|okay|ok|alright|basically|actually|and|but)[,:]?\s+/i,
	// The user asking something: "the user asks about X" / "the user is asking
	// what X is" -> "X" / "what X is". Asking strips without a connector, like
	// the bare 问 in Chinese.
	/^(?:the )?user(?:'s)? (?:is |are |was |were )?ask(?:s|ed|ing)?(?: me| us)? (?:(?:to|for|about) )?/i,
	// The asker's question named as a noun: "the user's question is about X" -> "X".
	/^(?:the )?user(?:'s)? questions?(?: is| was)? (?:about|regarding) /i,
	// The user wanting something: "the user wants to search…" -> "search…".
	// A connector is required, so "the user wants a fix" keeps its subject.
	/^(?:the )?user(?:'s)? (?:wants?|wanted|requests?|requested|needs?|needed|would like)(?: me| us)? (?:to|for|about) /i,
	// Bare modals: "need to check…" -> "check…".
	/^(?:need|needs|needed|have|has|had|want|wants|wanted|ought|used|plan|plans|planned) to /i,
	// Noticing lead-ins: "I see that the cache…" -> "the cache…".
	/^(?:i|we) (?:notice|noticed|see|saw|realize|realized|find|found|understand|understood|think|thought|guess|assume|assumed|remember) (?:that )?/i,
	// First-person lead-ins: "I need to check…" -> "check…".
	/^(?:i|we)(?:'m|'re| am| are) going to /i,
	/^(?:i|we) (?:need|needs|needed|have|has|had|want|wants|wanted|ought|used|plan|plans|planned) to /i,
	/^(?:i|we)(?:'ll|'d|'m|'re|'ve| will| would| should| must| shall| can| could| may| might| have| has| had| am| are) /i,
	/^let(?:'s| us| me) /i
];

// Words that add nothing to a title wherever they sit: 获取一些信息 -> 获取信息,
// "check some logs" -> "check logs".
const TITLE_FILLER_RE = /(?:一些|一下)|\bsome\s+(?=\p{L})/giu;

// The same fillers, but only when they open the title: "一些用户要求…" loses
// 一些 before the preamble strip, which then counts as a stripped lead.
const LEADING_TITLE_FILLER_RE = /^(?:(?:一些|一下)|\bsome\s+(?=\p{L}))/u;

// Quote pairs a lead may carry, with the mark that opens them. An apostrophe
// only opens a quote when it does not sit inside a word ("the user's"), so
// contractions are never paired up.
const TITLE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['“', '”'],
	['『', '』'],
	['「', '」'],
	['‘', '’'],
	['"', '"'],
	["'", "'"]
];

// Quoted content longer than this (4 words, or 8 CJK characters) is what the
// block is about: the quote becomes the title instead of the sentence carrying
// it. Shorter quotes stay part of the surrounding lead, which is usually the
// point there ("检查"登录失败"的原因").
const TITLE_QUOTE_TOKEN_TARGET = 4;

// First quoted span of the line whose content is longer than the quote target,
// or null. `end` points just past the closing mark, so consuming through it
// lifts the whole quote out of the block.
function findLongQuotedSpan(line: string): { text: string; end: number } | null {
	for (let i = 0; i < line.length; i++) {
		for (const [open, close] of TITLE_QUOTE_PAIRS) {
			if (!line.startsWith(open, i)) {
				continue;
			}

			if (open === "'" && /[\p{L}\p{N}]/u.test(line[i - 1] ?? '')) {
				continue;
			}

			const closeIndex = line.indexOf(close, i + open.length);
			if (closeIndex === -1) {
				continue;
			}

			const inner = line.slice(i + open.length, closeIndex);
			if (countReasoningTokens(inner) > TITLE_QUOTE_TOKEN_TARGET) {
				return { text: inner, end: closeIndex + close.length };
			}

			// The span is too short to title with: skip past its closing mark as
			// well, so the closing mark cannot open the next span and swallow the
			// prose between two quotes.
			i = closeIndex + close.length - 1;
			break;
		}
	}

	return null;
}

// Where a cut structural title may break: word spaces plus clause and CJK
// sentence separators. The continuation then starts at a fresh word or clause
// instead of inside one.
const TITLE_BREAK_RE = /[\s、，；：。！？,;:—–]/;

const TABLE_DELIMITER_RE = /^[\s|:\-–—]+$/;

function isTableDelimiter(line: string): boolean {
	return line.includes('|') && line.includes('-') && TABLE_DELIMITER_RE.test(line);
}

function stripInlineMarkdown(text: string): string {
	return (
		text
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
			.replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
			// Math delimiters read as plain text (the LaTeX source stays): KaTeX
			// renders asynchronously, which would grow the rendered height late.
			.replace(/\$\$([\s\S]+?)\$\$/g, '$1')
			.replace(/\$([^$\n]+?)\$/g, '$1')
			.replace(/\\\[([\s\S]+?)\\\]/g, '$1')
			.replace(/\\\(([^)]+?)\\\)/g, '$1')
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/__(.+?)__/g, '$1')
			.replace(/~~(.+?)~~/g, '$1')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

// Unwinds the framing a title does not need: each pass strips the first
// matching preamble phrase, so labels stack ("好的，用户要求…", "so the user
// wants to…") without one combined pattern per combination. A strip that would
// leave less than a usable title is refused.
function stripTitlePreamble(text: string): string {
	for (let pass = 0; pass < TITLE_PREAMBLE_RES.length; pass++) {
		let stripped = false;

		for (const pattern of TITLE_PREAMBLE_RES) {
			if (!pattern.test(text)) {
				continue;
			}

			const next = text.replace(pattern, '').trimStart();
			if (Array.from(next).length < TITLE_MIN_CHARS) {
				continue;
			}

			text = next;
			stripped = true;
			break;
		}

		if (!stripped) {
			break;
		}
	}

	return text;
}

// Function words a lead never ends on: a title ending in one of these ("查询的
// 大致步骤可能是", "……original_id IS NULL 或者", "反转单词顺序得到") was cut
// mid-thought, so the ending is dropped together with whatever separators it
// leaves behind. Dangling words chain ("……可能是需要"), so the strip repeats.
const TITLE_DANGLING_ENDING_RE =
	/(?:可能|应该|需要|比如|例如|或者|得到|在于|包括|要|还|也|都|就|又|再|并|而|但|是|的|了|着|过|与|和|及|或)+$/u;
const TITLE_TRAILING_SEPARATORS_RE = /[\s.*_~…。！？；：，、;:!?,～\-—–]+$/u;

function stripDanglingTitleEnding(title: string): string {
	let text = title;

	for (;;) {
		const next = text
			.replace(TITLE_DANGLING_ENDING_RE, '')
			.replace(TITLE_TRAILING_SEPARATORS_RE, '')
			.trimEnd();

		if (next === text || Array.from(next).length < TITLE_MIN_CHARS) {
			return text;
		}

		text = next;
	}
}

// Cleans a title source and reports whether anything in front of the title was
// lifted out (filler openers, sequencing words, the asking preamble). The body
// uses that to keep the original text instead of skipping it.
function cleanTitleSource(raw: string): { title: string; leadStripped: boolean } {
	let text = stripInlineMarkdown(raw.replace(/^>\s?/, ''));
	let leadStripped = false;

	const withoutLeadFiller = text.replace(LEAD_FILLER_RE, '');
	if (withoutLeadFiller !== text) {
		leadStripped = true;
		text = withoutLeadFiller;
	}

	// Order matters: filler words are removed before the preamble so
	// "一些用户要求…" still reads as the asker to strip.
	leadStripped = leadStripped || LEADING_TITLE_FILLER_RE.test(text);
	text = text.replace(TITLE_FILLER_RE, '');

	const withoutPreamble = stripTitlePreamble(text);
	if (withoutPreamble !== text) {
		leadStripped = true;
		text = withoutPreamble;
	}

	return {
		title: stripDanglingTitleEnding(
			text
				.replace(TITLE_FILLER_RE, '')
				.replace(/^[\s.*_~…。！？；：，、;:!?,～\-—–]+/u, '')
				.replace(/[\s.*_~…。！？；：，、;:!?,～\-—–]+$/u, '')
				.replace(/\s+/g, ' ')
				.trim()
		),
		leadStripped
	};
}

// A title is a lead: count tokens the same way blocks are cut, and once the
// target is reached cut at the next punctuation. The cut-off part is dropped;
// the rest of the block still follows as the body. Punctuation inside math or
// inline code does not end a title.
function cutTitleAtPunctuation(text: string): { title: string; consumed: number } {
	let inMath = false;
	let inCode = false;

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (char === '`') {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			continue;
		}
		if (char === '$' && text[i + 1] === '$') {
			inMath = !inMath;
			i += 1;
			continue;
		}
		if (char === '$') {
			inMath = !inMath;
			continue;
		}
		if (inMath || !isTitleBoundary(text, i)) {
			continue;
		}

		if (countReasoningTokens(text.slice(0, i)) >= REASONING_BLOCK_TITLE_TOKEN_TARGET) {
			return { title: text.slice(0, i), consumed: i + 1 };
		}
	}

	return { title: text, consumed: text.length };
}

const TITLE_BOUNDARY_CHARS = '，、；：。！？…';

// Sentence and clause punctuation; an ASCII period only when it ends the text or
// is followed by whitespace and is not a decimal separator.
function isTitleBoundary(text: string, i: number): boolean {
	const char = text[i];
	if (TITLE_BOUNDARY_CHARS.includes(char) || ',;:!?'.includes(char)) {
		return true;
	}

	if (char === '.') {
		const prev = text[i - 1] ?? '';
		const next = text[i + 1] ?? '';
		return !(/\d/.test(prev) && /\d/.test(next)) && (next === '' || /\s/.test(next));
	}

	return false;
}

// English leads carry syntactic glue a title does not need: articles, the dummy
// object "it", the infinitive marker "to", copulas and auxiliaries are dropped,
// leaving the content words in order — "Rewrite the function to make it easier
// to analyze" becomes "Rewrite function make easier analyze". Modals and the
// base "be" stay, so "The parser must not swallow…" keeps its "must" and "The
// function should be checked" keeps "should be checked" readable, and the "to"
// after a catenative verb ("want to handle") stays too — dropping it would glue
// two verbs together. Only whole Latin words match, so Chinese titles pass
// through untouched.
const ENGLISH_FUNCTION_PHRASE_RE =
	/\b(?:be|is|are|was|were|am)\s+able\s+to\b|\b(?:have|has|had)\s+to\s+be\b/giu;
const ENGLISH_FUNCTION_WORD_RE =
	/(?<![\w'’-])(?:an|a|the|it['’]s|that['’]s|its|(?<!(?:how|that|whether|when|where|why|if|and|but|or|because|so|which|who) )it(?!\s+(?:might|may|will|would|shall|should|can|could|must|do|does|did|has|have|had|need|needs)\b)|(?<!\b(?:want|wants|wanted|need|needs|needed|try|tries|tried|plan|plans|planned|hope|hopes|hoped|decide|decides|decided|expect|expects|expected|seem|seems|seemed|appear|appears|appeared|tend|tends|tended|fail|fails|failed|manage|manages|managed|promise|promises|promised|ask|asks|asked|afford|affords|afforded|learn|learns|learned|choose|chooses|chose|mean|means|meant|start|starts|started|begin|begins|began|continue|continues|continued|like|likes|liked|prefer|prefers|preferred|forget|forgets|forgot|remember|remembers|remembered|offer|offers|offered|agree|agrees|agreed|refuse|refuses|refused|pretend|pretends|pretended|claim|claims|claimed|happen|happens|happened|struggle|struggles|struggled|prepare|prepares|prepared|arrange|arranges|arranged|dare|dares|dared|help|helps|helped|going|gonna|used|able|ought)\s+)to|is|are|was|were|am|there|have|has|had|do|does|did)(?![\w'’-])/giu;

function stripEnglishFunctionWords(title: string): string {
	const stripped = title
		.replace(ENGLISH_FUNCTION_PHRASE_RE, ' ')
		.replace(ENGLISH_FUNCTION_WORD_RE, ' ')
		.replace(/\s+([,;:.!?])/gu, '$1')
		.replace(/\s+/gu, ' ')
		.trim();

	return Array.from(stripped).length >= TITLE_MIN_CHARS ? stripped : title;
}

// Fits a title to the display-width cap: a wider one shows a fitting prefix,
// broken at the last word space or clause separator so the cut does not land
// inside a word or clause, with an ellipsis marking what was dropped.
function fitTitleWidth(title: string): string {
	if (displayWidth(title) <= REASONING_BLOCK_TITLE_MAX_WIDTH) {
		return title;
	}

	let window = '';
	let width = 0;
	for (const char of title) {
		const nextWidth = width + charWidth(char);
		if (nextWidth > REASONING_BLOCK_TITLE_MAX_WIDTH) {
			break;
		}
		window += char;
		width = nextWidth;
	}

	let breakAt = -1;
	for (let i = window.length - 1; i >= 0; i--) {
		if (TITLE_BREAK_RE.test(window[i])) {
			breakAt = i;
			break;
		}
	}
	if (breakAt + 1 >= window.length / 2) {
		window = window.slice(0, breakAt + 1);
	}

	const cut = window
		.replace(/[\s.*_~…。！？；：，、;:!?,～\-—–]+$/u, '')
		// A cut can land anywhere, so a trailing connector ("...individual words
		// while") is dropped like the dangling endings of a Chinese title.
		.replace(
			/[\s,]+(?:and|or|but|while|when|if|that|which|because|so|then|than|to|of|in|on|at|for|with|from|by|as)\s*$/iu,
			''
		);

	return cut ? `${cut}…` : title;
}

// Turns the `[sourceStart, sourceEnd)` region of the block into a title. The
// title is carved through `consumedEnd`, which may cover more than the source
// itself (the bold markers and separator of a `**Label:**` lead). The width cap
// applies to the cleaned title: a wider one shows a fitting prefix with an
// ellipsis while the source is consumed whole, so no half of a marker can leak
// into the rest.
function carveTitle(
	text: string,
	sourceStart: number,
	sourceEnd: number,
	consumedEnd: number
): TitleCandidate {
	const rawSource = text.slice(sourceStart, sourceEnd);
	if (!rawSource.trim()) {
		return NO_TITLE;
	}

	const cleaned = cleanTitleSource(cutTitleAtPunctuation(rawSource).title);
	if (!cleaned.title) {
		return NO_TITLE;
	}

	return { ...cleaned, title: fitTitleWidth(cleaned.title), consumed: consumedEnd };
}

// ---------------------------------------------------------------------------
// Topic-word pruning of the opening sentence.
//
// The title is the block's opening sentence — up to the first full stop — with
// the words that do not carry its topic removed: each term is weighted by how
// often the block uses it (tf) and how rare it is among the reasoning's
// sentences (idf), and the heaviest terms are kept while framing, glue words
// and one-off fragments are deleted. The IDF part is damped hard — a light
// multiplier, not the driver — so a rare crossing fragment cannot outrank a
// word the block actually repeats. Clause punctuation between kept words
// survives, so the result still reads like a sentence.
//
// There is no dictionary: a CJK run is split into overlapping bigrams ("递归处
// 理" -> 递归/归处/处理), so a bigram that merely straddles a word boundary
// ("符的", "在递", "个单") can look like a term. Those are filtered as whole
// words and by character, and what still slips through is rare enough to lose
// the weight comparison.
// ---------------------------------------------------------------------------

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

const TERM_RUN_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[A-Za-z][A-Za-z0-9'’-]*|\d+(?:[.,]\d+)*/gu;

type TermSpan = { term: string; start: number; end: number };

// CJK runs become overlapping bigrams — the cheapest segmentation that still
// surfaces real words ("递归", "元音") — single characters stay as themselves,
// and Latin and digit runs are kept as words.
function extractTermSpans(text: string): TermSpan[] {
	const spans: TermSpan[] = [];

	for (const match of text.matchAll(TERM_RUN_RE)) {
		const run = match[0];
		const at = match.index ?? 0;

		if (CJK_RUN_RE.test(run[0])) {
			if (run.length === 1) {
				spans.push({ term: run, start: at, end: at + 1 });
			} else {
				for (let i = 0; i + 2 <= run.length; i++) {
					spans.push({ term: run.slice(i, i + 2), start: at + i, end: at + i + 2 });
				}
			}
		} else if (run.length >= 2) {
			spans.push({ term: run.toLowerCase(), start: at, end: at + run.length });
		}
	}

	return spans;
}

type SentenceSpan = { start: number; end: number; text: string };

const SENTENCE_END_CHARS = '。！？!?…；;';
const SENTENCE_CLOSE_CHARS = '”"’\'）」』）';

// The reasoning's sentences are the documents of the IDF corpus.
function splitSentences(text: string): SentenceSpan[] {
	const sentences: SentenceSpan[] = [];
	let start = 0;

	const push = (end: number) => {
		const raw = text.slice(start, end);
		const lead = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		if (trimmed) {
			sentences.push({ start: start + lead, end: start + lead + trimmed.length, text: trimmed });
		}
		start = end;
	};

	for (let i = 0; i < text.length; i++) {
		const char = text[i];

		if (SENTENCE_END_CHARS.includes(char)) {
			let end = i + 1;
			while (end < text.length && SENTENCE_CLOSE_CHARS.includes(text[end])) {
				end++;
			}
			push(end);
			i = end - 1;
			continue;
		}

		if (char === '\n') {
			push(i + 1);
			continue;
		}

		if (char === '.') {
			const prev = text[i - 1] ?? '';
			const next = text[i + 1] ?? '';
			if (!/\d/.test(prev) && (next === '' || /\s/.test(next))) {
				push(i + 1);
			}
		}
	}

	push(text.length);

	return sentences;
}

// Inverse document frequency of each term over the reasoning's sentences. Terms
// that show up in half the sentences or more score zero — they say nothing
// about any one block.
let tfidfIdf = new Map<string, number>();

function buildTfIdfCorpus(markdown: string): void {
	const sentences = splitSentences(markdown);
	const df = new Map<string, number>();

	for (const sentence of sentences) {
		for (const term of new Set(extractTermSpans(sentence.text).map((span) => span.term))) {
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}

	tfidfIdf = new Map();
	for (const [term, count] of df) {
		tfidfIdf.set(term, Math.max(Math.log(sentences.length / (1 + count)), 0));
	}
}

// Words that never carry a topic: discourse glue, framing and pronouns. CJK
// terms are the bigrams the term extractor produces; Latin ones are whole
// words. Single CJK characters are never kept either — content words are two
// characters or longer.
//
// 用户 ("the user") is deliberately not listed: readable reasoning tracks are
// about the user's own problem, and keeping the word also suppresses the
// crossing fragment that would sit in its place ("用户提供" would otherwise
// contribute 户提).
const CJK_GLUE_TERMS = new Set([
	'我们',
	'我们',
	'你们',
	'他们',
	'它们',
	'咱们',
	'自己',
	'大家',
	'这个',
	'那个',
	'这些',
	'那些',
	'这里',
	'那里',
	'什么',
	'怎么',
	'这样',
	'那样',
	'一个',
	'一些',
	'一下',
	'一样',
	'一起',
	'如何',
	'然后',
	'接着',
	'之后',
	'最后',
	'首先',
	'其次',
	'现在',
	'想要',
	'如果',
	'因为',
	'所以',
	'因此',
	'但是',
	'可是',
	'不过',
	'希望',
	'而且',
	'并且',
	'或者',
	'还是',
	'就是',
	'只是',
	'而是',
	'不是',
	'没有',
	'已经',
	'还要',
	'同时',
	'另外',
	'此外',
	'关于',
	'对于',
	'通过',
	'根据',
	'按照',
	'只要',
	'只有',
	'无论',
	'可能',
	'应该',
	'需要',
	'可以',
	'能够',
	'必须',
	'也许',
	'大概',
	'似乎',
	'或许',
	'例如',
	'比如',
	'譬如',
	'诸如',
	'时候',
	'进行',
	'等等',
	'之类',
	'以及',
	'甚至',
	'依然',
	'仍然',
	'于是',
	'那么',
	'这么',
	'以后',
	'之前',
	'打算',
	'准备',
	'觉得',
	'认为',
	'猜测',
	'确实',
	'其实',
	'要么',
	'假如',
	'即使',
	'虽然',
	'尽管',
	'既然',
	'从而',
	'进而',
	'反而',
	'总之',
	'综上',
	'为了',
	'作为',
	'看看',
	'试试',
	'知道',
	'假设',
	'同样',
	'不会',
	'不能'
]);

// Characters that are pure glue wherever they appear: a term built from them —
// including a bigram that merely straddles one ("符的", "音是", "个单") — never
// carries a topic.
const CJK_GLUE_CHARS = new Set(
	'的了着是个什么吗呢吧啊嗯哦呀啦哪谁怎之其此这那把被让给从向而但并就也都还又再更很太等与和及或于各每某才却则将要来在中者进一没几'
		.split('')
		.concat(['呗', '唉'])
);

const LATIN_GLUE_TERMS = new Set([
	'the',
	'a',
	'an',
	'and',
	'or',
	'but',
	'if',
	'then',
	'else',
	'of',
	'to',
	'in',
	'on',
	'at',
	'by',
	'for',
	'with',
	'from',
	'into',
	'over',
	'under',
	'about',
	'as',
	'is',
	'are',
	'was',
	'were',
	'be',
	'been',
	'being',
	'it',
	'its',
	'this',
	'that',
	'these',
	'those',
	'there',
	'here',
	'where',
	'when',
	'why',
	'how',
	'what',
	'which',
	'who',
	'whom',
	'whose',
	'we',
	'you',
	'they',
	'he',
	'she',
	'i',
	'me',
	'my',
	'our',
	'your',
	'their',
	'us',
	'them',
	'user',
	'also',
	'just',
	'more',
	'most',
	'some',
	'any',
	'all',
	'not',
	'no',
	'yes',
	'can',
	'could',
	'should',
	'would',
	'may',
	'might',
	'will',
	'shall',
	'must',
	'need',
	'needs',
	'needed',
	'want',
	'wants',
	'wanted',
	'let',
	"let's",
	'alright',
	'yeah',
	'so',
	'hmm',
	'hm',
	'maybe',
	'perhaps',
	'think',
	'thought',
	'wonder',
	'first',
	'second',
	'third',
	'finally',
	'next',
	'now',
	'well',
	'okay',
	'ok',
	'sure',
	'actually',
	'basically',
	'really',
	'very',
	'much',
	'many',
	'every',
	'each',
	'only',
	'even',
	'still',
	'like',
	'know',
	'see',
	'get',
	'gets',
	'got',
	'make',
	'makes',
	'made',
	'going',
	'gonna',
	'look',
	'however',
	'therefore',
	'though',
	'although',
	'while',
	'since',
	'do',
	'does',
	'did',
	'doing',
	'has',
	'have',
	'had',
	"can't",
	"won't"
]);

// A term must be used at least this often in the block to carry its topic: a
// one-off word is usually a crossing fragment or a passing detail.
const PRUNE_TERM_MIN_TF = 2;

// A title keeps at most this many words.
const PRUNE_MAX_TERMS = 7;

// How strongly rarity (IDF) modulates block frequency in a term's weight.
const PRUNE_IDF_EXPONENT = 0.25;

// Chains of overlapping terms are merged into one word, at most this long:
// "无人" + "人机" = "无人机", "分隔" + "隔符" = "分隔符".
const PRUNE_MERGE_MAX_CHARS = 6;

// A bigram whose every occurrence sits between the same two characters is a
// fragment of one longer phrase the block repeats — "假设现在…" repeats as a
// unit, so 设现 always sits between 假 and 在 and is not a word of its own.
// Fragments that ever touch a word boundary are kept, so a phrase that opens
// sentences keeps its words.
function collectFixedFragmentTerms(blockText: string): Set<string> {
	type Context = { count: number; before: Set<string>; after: Set<string>; boundary: boolean };
	const contexts = new Map<string, Context>();

	for (const span of extractTermSpans(blockText)) {
		let entry = contexts.get(span.term);
		if (!entry) {
			entry = { count: 0, before: new Set(), after: new Set(), boundary: false };
			contexts.set(span.term, entry);
		}
		entry.count++;

		const before = blockText[span.start - 1] ?? '';
		const after = blockText[span.end] ?? '';

		if (CJK_RUN_RE.test(before)) {
			entry.before.add(before);
		} else {
			entry.boundary = true;
		}
		if (CJK_RUN_RE.test(after)) {
			entry.after.add(after);
		} else {
			entry.boundary = true;
		}
	}

	const fragments = new Set<string>();
	for (const [term, entry] of contexts) {
		if (entry.count >= 2 && !entry.boundary && entry.before.size === 1 && entry.after.size === 1) {
			fragments.add(term);
		}
	}

	return fragments;
}

function isGlueTerm(term: string): boolean {
	if (CJK_RUN_RE.test(term)) {
		if (Array.from(term).length < 2 || CJK_GLUE_TERMS.has(term)) {
			return true;
		}
		return [...term].some((char) => CJK_GLUE_CHARS.has(char));
	}

	if (LATIN_GLUE_TERMS.has(term)) {
		return true;
	}

	// Contractions resolve to their base word: "it's", "we're", "don't".
	const base = term.replace(/n['’]t$/i, '').replace(/['’](?:s|m|re|ve|ll|d)$/i, '');
	return base !== term && LATIN_GLUE_TERMS.has(base);
}

// The block's opening sentence with everything but its topic words removed, or
// null when the pruning cannot title (no full stop, fewer than two kept words).
//
// Only the Chinese full stop ends the source sentence. English keeps the plain
// lead cut instead: its words repeat too rarely per block for the frequency
// gate, so pruning there dissolves titles into stray keywords ("So words
// sentence keeping punctuation word") where the lead already reads cleanly
// ("Design a recursive function that reverses the words in a sentence") — the
// spaces give the cut free word and clause boundaries.
function pruneTopicWords(text: string): string | null {
	const end = text.indexOf('。');
	if (end === -1) {
		return null;
	}

	const source = text.slice(0, end + 1);

	const blockTf = new Map<string, number>();
	for (const span of extractTermSpans(text)) {
		blockTf.set(span.term, (blockTf.get(span.term) ?? 0) + 1);
	}
	const fixedFragments = collectFixedFragmentTerms(text);

	const scored: { span: TermSpan; weight: number }[] = [];
	for (const span of extractTermSpans(source)) {
		if (isGlueTerm(span.term) || fixedFragments.has(span.term)) {
			continue;
		}

		const tf = blockTf.get(span.term) ?? 0;
		if (tf < PRUNE_TERM_MIN_TF) {
			continue;
		}

		scored.push({
			span,
			weight: (1 + Math.log(tf)) * Math.pow(1 + (tfidfIdf.get(span.term) ?? 0), PRUNE_IDF_EXPONENT)
		});
	}

	scored.sort((a, b) => b.weight - a.weight || a.span.start - b.span.start);

	const kept = new Map<string, TermSpan>();
	for (const { span } of scored) {
		if (kept.size >= PRUNE_MAX_TERMS) {
			break;
		}
		if (kept.has(span.term)) {
			continue;
		}
		if ([...kept.values()].some((taken) => span.start < taken.end && taken.start < span.end)) {
			continue;
		}
		kept.set(span.term, span);
	}

	if (kept.size < 2) {
		return null;
	}

	// Merge overlapping chains into whole words: when a strong term continues
	// the one beside it by one character ("无人" + "人机" = "无人机", "分隔" +
	// "隔符" = "分隔符", "生成" + "成器" = "生成器"), the extractor split one
	// word in two and the union puts it back together. The absorbed part must be
	// at least as frequent as the word it joins (a real half of the word occurs
	// wherever the whole does; a crossing fragment is rarer — "户提" of "用户
	// 提到/提供" appears far less often than "用户"), and crossing fragments
	// that would glue two words this way ("据分" of "数据分析") are already
	// gone — the glue and fixed-context filters drop them.
	const byWindow = new Map<string, TermSpan>();
	for (const { span } of scored) {
		byWindow.set(`${span.start}:${span.end}`, span);
	}

	const merged: TermSpan[] = [];
	for (const span of kept.values()) {
		let start = span.start;
		let end = span.end;
		const spanTf = blockTf.get(span.term) ?? 0;

		while (end - start < PRUNE_MERGE_MAX_CHARS) {
			const right = byWindow.get(`${end - 1}:${end + 1}`);
			if (!right || (blockTf.get(right.term) ?? 0) < spanTf) {
				break;
			}
			end = right.end;
		}

		while (end - start < PRUNE_MERGE_MAX_CHARS) {
			const left = byWindow.get(`${start - 1}:${start + 1}`);
			if (!left || (blockTf.get(left.term) ?? 0) < spanTf) {
				break;
			}
			start = left.start;
		}

		merged.push({ term: source.slice(start, end), start, end });
	}
	merged.sort((a, b) => a.start - b.start);

	// A trailing subject reads broken as a title ("回调触发条件用户"): drop it.
	while (
		merged.length > 1 &&
		source.slice(merged[merged.length - 1].start, merged[merged.length - 1].end) === '用户'
	) {
		merged.pop();
	}

	// A subject dangling before a separator reads like a one-word list entry
	// ("用户，系列电影…"): drop it.
	if (
		merged.length > 1 &&
		source.slice(merged[0].start, merged[0].end) === '用户' &&
		/[，、；：]/u.test(source.slice(merged[0].end, merged[1].start))
	) {
		merged.shift();
	}

	const emitted = new Set<string>();
	let title = '';
	let prev: TermSpan | null = null;

	for (const span of merged) {
		if (prev && span.start < prev.end) {
			continue; // covered by a neighbour's merge
		}

		const text = source.slice(span.start, span.end);
		if (emitted.has(text)) {
			continue; // the same word, merged from another occurrence
		}
		emitted.add(text);

		if (prev) {
			const gap = source.slice(prev.end, span.start);
			const punctuation = /[，、；：]/u.exec(gap);
			if (punctuation) {
				title += punctuation[0];
			} else if (
				/[A-Za-z0-9]/.test(source[prev.end - 1] ?? '') &&
				/[A-Za-z0-9]/.test(source[span.start] ?? '')
			) {
				title += ' ';
			}
		}
		title += text;
		prev = span;
	}

	return title.trim() || null;
}

function derivePrunedLeadTitle(text: string): TitleCandidate | null {
	const pruned = pruneTopicWords(text);
	if (!pruned || Array.from(pruned).length < TITLE_MIN_CHARS) {
		return null;
	}

	const consumed = text.indexOf('。') + 1;
	if (!text.slice(consumed).trim()) {
		return null;
	}

	return { title: pruned, consumed, leadStripped: false };
}

function findTitleCandidate(blockText: string): TitleCandidate {
	// The whole block reads as one line first: a quote or label that opens on one
	// line and continues on the next is one span, and a line break inside the lead
	// leaves no trace. Newlines become single spaces — the length is kept, so
	// every offset still points into the original block.
	const text = blockText.replace(/\n/g, ' ');

	// Structure, though, lives on the original opening line — a heading, a list
	// item or a table row only means something on the line it was written on.
	const lineEnd = blockText.indexOf('\n') === -1 ? blockText.length : blockText.indexOf('\n');
	const rawFirstLine = blockText.slice(0, lineEnd);
	const firstLine = rawFirstLine.trim();
	const lineStart = rawFirstLine.length - rawFirstLine.trimStart().length;

	// Blocks whose opening line carries structure must keep it intact: carving a
	// title out of a list item, a fence or a table row would corrupt the
	// rendered markdown, so those blocks render titleless.
	if (LIST_ITEM_RE.test(firstLine) || /^(?:```|~~~)/.test(firstLine)) {
		return NO_TITLE;
	}

	const secondLine = blockText
		.slice(lineEnd + 1)
		.split('\n', 1)[0]
		.trim();
	if (firstLine.includes('|') && isTableDelimiter(secondLine)) {
		return NO_TITLE;
	}

	const cut = cutTitleAtPunctuation(text);

	// A long quote in the lead is what the block is about: the quoted text itself
	// is the lead to title ("用户询问的是"为什么缓存会失效"" -> "为什么缓存会失效"),
	// not the framing around it. It is processed like any other lead afterwards.
	// The search stops where the plain lead would end — a stray pair of quote
	// marks deeper in the block (a code snippet) must not swallow whole lines.
	const quote = findLongQuotedSpan(text.slice(0, cut.consumed));
	if (quote) {
		const quoteCut = cutTitleAtPunctuation(quote.text);
		const cleaned = cleanTitleSource(quoteCut.title);
		if (Array.from(cleaned.title).length >= TITLE_MIN_CHARS) {
			// Swallow the separator between the quote and the body, the way a bold
			// `**Label:** rest` lead does.
			const separator = /^\s*[:：,，、;；.。!！?？]/.exec(text.slice(quote.end));
			const consumed = quote.end + (separator?.[0].length ?? 0);
			// The span was lifted out of the sentence carrying it, so the body
			// keeps that sentence in its original form.
			return { title: cleaned.title, consumed, leadStripped: true };
		}
	}

	// Explicit heading.
	const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(firstLine);
	if (heading) {
		const start = lineStart + heading[0].indexOf(heading[1]);
		return carveTitle(text, start, start + heading[1].length, lineEnd);
	}

	// A line that is entirely bold, or a bold lead-in such as `**Label:** rest`.
	const boldLine = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/.exec(firstLine);
	if (boldLine) {
		const start = lineStart + boldLine[0].indexOf(boldLine[1]);
		return carveTitle(text, start, start + boldLine[1].length, lineEnd);
	}

	const boldLead = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:：,，、;；]?\s*/.exec(firstLine);
	if (boldLead) {
		const start = lineStart + boldLead[0].indexOf(boldLead[1]);
		return carveTitle(text, start, start + boldLead[1].length, lineStart + boldLead[0].length);
	}

	// Prose: the title is the block's opening sentence with the words that do
	// not carry its topic removed. Fallback when the pruning cannot title: the
	// block's lead — counted in tokens the same way blocks are cut and ended at
	// the next punctuation once the target is reached. This keeps one-word
	// sentences ("Wait.") from becoming the whole title while still stopping on
	// a natural boundary.
	const pruned = derivePrunedLeadTitle(text);
	if (pruned) {
		return pruned;
	}

	const cleaned = cleanTitleSource(cut.title);
	if (Array.from(cleaned.title).length < TITLE_MIN_CHARS) {
		return NO_TITLE;
	}

	// A block is only titled when something follows its lead.
	return !text.slice(cut.consumed).trim()
		? NO_TITLE
		: {
				title: fitTitleWidth(stripEnglishFunctionWords(cleaned.title)),
				consumed: cut.consumed,
				leadStripped: cleaned.leadStripped
			};
}

// A title that says the whole block ("先看看问题。" -> "先看看问题") is not worth
// showing: the block already reads as its own title, so it renders without one.
function deriveReasoningBlockTitle(text: string): TitleCandidate {
	const candidate = findTitleCandidate(text);
	if (!candidate.title || !text.slice(candidate.consumed).trim()) {
		return NO_TITLE;
	}
	return candidate;
}

// A block renders on its own, so a bold marker whose counterpart is missing —
// the model never closed it, or its partner lives in another block — can only
// show up literally. Drop the unpaired one instead.
function stripUnpairedBoldMarkers(text: string): string {
	for (const marker of ['**', '__']) {
		const opensOnly = text.startsWith(marker) && text.indexOf(marker, marker.length) === -1;
		const closesOnly =
			text.endsWith(marker) && text.indexOf(marker) === text.length - marker.length;

		if (opensOnly) {
			text = text.slice(marker.length);
		} else if (closesOnly) {
			text = text.slice(0, text.length - marker.length);
		}
	}
	return text;
}

// A title is rendered as a bold lead line, so markdown markers inside it would
// leak into the formatting.
function escapeTitleMarkdown(title: string): string {
	return title.replace(/([*_`~\\])/g, '\\$1');
}

// A block renders as its own Markdown instance, where a blank line would open
// a paragraph gap again. Runs of blank lines therefore collapse to single line
// breaks inside a block; a fenced code block keeps its blank lines, since there
// they are part of the code.
function dropBlockBlankLines(lines: string[]): string[] {
	const kept: string[] = [];
	let inFence = false;
	let fenceMarker = '';

	for (const line of lines) {
		const trimmed = line.trim();

		const fenceMatch = /^(```|~~~)/.exec(trimmed);
		if (fenceMatch) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fenceMatch[1];
			} else if (trimmed.startsWith(fenceMarker)) {
				inFence = false;
				fenceMarker = '';
			}
		}

		if (inFence || trimmed !== '') {
			kept.push(line);
		}
	}

	return kept;
}

// Removes fenced code blocks, fences included, from the body: the code would
// otherwise dominate the body's token budget.
function dropFencedCodeBlocks(text: string): string {
	const kept: string[] = [];
	let inFence = false;
	let fenceMarker = '';

	for (const line of text.split('\n')) {
		const trimmed = line.trim();

		const fenceMatch = /^(```|~~~)/.exec(trimmed);
		if (fenceMatch) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fenceMatch[1];
			} else if (trimmed.startsWith(fenceMarker)) {
				inFence = false;
				fenceMarker = '';
			}
			continue;
		}

		if (!inFence) {
			kept.push(line);
		}
	}

	return kept.join('\n');
}

// The body renders as plain text: its markdown markers are removed and the
// lines are joined with spaces, so a block reads as one line of content under
// its title. Fenced code blocks are dropped whole before the body is cut to its
// token budget; inline code keeps its text, and ordered-list numbers stay since
// they carry meaning.
function stripBodyMarkdown(text: string): string {
	return (
		dropFencedCodeBlocks(text)
			.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, '$1') // images
			.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, '$1') // links
			.replace(/`{1,3}([^`\n]*)`{1,3}/g, '$1') // inline code
			// Math delimiters read as plain text; KaTeX would otherwise render
			// asynchronously and grow the block after it is measured.
			.replace(/\$\$([\s\S]+?)\$\$/g, '$1') // display math
			.replace(/\$([^$\n]+?)\$/g, '$1') // inline math
			.replace(/\\\[([\s\S]+?)\\\]/g, '$1') // \[ ... \]
			.replace(/\\\(([^)]+?)\\\)/g, '$1') // \( ... \)
			.replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading markers
			.replace(/^\s{0,3}>\s?/gm, '') // blockquote markers
			.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, '') // task-list markers
			.replace(/^\s*[-*+]\s+/gm, '') // bullet markers
			.replace(/^\s*(?=[\s:|-]*-)[\s:|-]*$/gm, '') // table delimiter rows
			.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '') // horizontal rules
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/__(.+?)__/g, '$1')
			.replace(/~~(.+?)~~/g, '$1')
			.replace(/(?<!\w)\*(?!\s)([^*\n]+?)(?<!\s)\*(?!\w)/g, '$1') // *emphasis*
			.replace(/(?<!\w)_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '$1') // _emphasis_
			.replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ') // html tags
			.replace(/\|/g, ' ') // table cells
			.replace(/\s+/g, ' ')
			.trim()
	);
}

export function buildReasoningBlocks(
	markdown: string,
	{
		streaming = false,
		tokenTarget = REASONING_BLOCK_TOKEN_TARGET,
		tokenLimit = REASONING_BLOCK_TOKEN_LIMIT
	}: BuildReasoningBlocksOptions = {}
): ReasoningBlock[] {
	const blocks: ReasoningBlock[] = [];
	buildTfIdfCorpus(markdown ?? '');
	let current: string[] = [];
	let tokens = 0;
	let inFence = false;
	let fenceMarker = '';

	const flush = () => {
		// Blank lines collapse so a block reads as tight lines, and markers whose
		// partner is missing render literally, so they are dropped too, before
		// the block is titled and rendered.
		const blockText = stripUnpairedBoldMarkers(dropBlockBlankLines(current).join('\n').trim());
		current = [];
		tokens = 0;
		if (!blockText) {
			return;
		}

		const { title, consumed, leadStripped } = deriveReasoningBlockTitle(blockText);
		// deriveReasoningBlockTitle only returns a title when text is left over,
		// so the body is the block with the title region carved out — unless
		// something in front of the title was stripped (a preamble, a quoting
		// frame), in which case the body keeps the original first sentence.
		const content = stripBodyMarkdown(
			title && !leadStripped ? blockText.slice(consumed) : blockText
		);
		const { text: body, truncated } = truncateReasoningTokens(content, tokenLimit);

		if (!title && !body) {
			return;
		}

		blocks.push({
			title,
			text: title
				? body
					? `**${escapeTitleMarkdown(title)}**\n${body}`
					: `**${escapeTitleMarkdown(title)}**`
				: body,
			truncated
		});
	};

	// While streaming, the text after the last newline is still being written:
	// it cannot be cut yet (a cut is always at a blank line) and does not count
	// toward the next cut either. It joins the pending block once its newline
	// arrives.
	const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
	const terminated = streaming ? Math.max(lines.length - 1, 0) : lines.length;

	for (let i = 0; i < terminated; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// A cut inside a fenced code block would break the code up, so the block
		// keeps growing until the fence closes.
		const fenceMatch = /^(```|~~~)/.exec(trimmed);
		if (fenceMatch) {
			if (!inFence) {
				inFence = true;
				fenceMarker = fenceMatch[1];
			} else if (trimmed.startsWith(fenceMarker)) {
				inFence = false;
				fenceMarker = '';
			}
		}

		// Once the block has reached its token target it ends at the next blank
		// line, so blocks also end at a paragraph boundary and not mid-paragraph.
		if (!inFence && trimmed === '' && tokens >= tokenTarget) {
			flush();
			continue;
		}

		current.push(line);
		tokens += countReasoningTokens(line);
	}

	for (let i = terminated; i < lines.length; i++) {
		current.push(lines[i]);
	}

	if (!streaming) {
		flush();
	}

	return blocks;
}

/**
 * Title for the live reasoning preview: the title of the last block that has
 * been fully generated. A block's title only appears once the block is complete
 * (cut at a blank line), so the preview never shows a title that could still
 * change. Empty while no block has been titled yet.
 *
 * The scan is incremental: state is cached per `cacheId` and only newly arrived
 * lines are counted.
 */
export function deriveReasoningPreview(cacheId: string, markdown: string): string {
	const text = markdown ?? '';
	if (!text) {
		return '';
	}

	let state = cacheId ? previewStates.get(cacheId) : undefined;
	if (!state) {
		state = createPreviewState();
		if (cacheId) {
			previewStates.set(cacheId, state);
			if (previewStates.size > PREVIEW_CACHE_LIMIT) {
				const oldest = previewStates.keys().next().value;
				if (oldest !== undefined) {
					previewStates.delete(oldest);
				}
			}
		}
	}

	processPreviewState(state, text);

	return state.lastCompletedTitle;
}

type PreviewState = {
	/** Length of the text the scan state applies to (complete lines only). */
	length: number;
	/** Tail of the scanned prefix, used to detect edits/replacements cheaply. */
	tail: string;
	/** Character offset where the trailing block starts. */
	blockStart: number;
	/** Tokens accumulated in the trailing block so far. */
	tokens: number;
	/** Title of the last fully generated block, shown until the next one has one. */
	lastCompletedTitle: string;
	inFence: boolean;
	fenceMarker: string;
};

const PREVIEW_CACHE_LIMIT = 100;
const PREVIEW_STATE_TAIL = 32;
const previewStates = new Map<string, PreviewState>();

function createPreviewState(): PreviewState {
	return {
		length: 0,
		tail: '',
		blockStart: 0,
		tokens: 0,
		lastCompletedTitle: '',
		inFence: false,
		fenceMarker: ''
	};
}

// Counts only the lines that arrived since the last call; earlier blocks are
// settled while streaming and never shift. Only lines terminated by a newline
// are counted, matching where a block can actually be cut.
function processPreviewState(state: PreviewState, markdown: string): void {
	const tailStart = Math.max(state.length - state.tail.length, 0);
	if (markdown.length < state.length || markdown.slice(tailStart, state.length) !== state.tail) {
		Object.assign(state, createPreviewState());
	}

	const end = markdown.lastIndexOf('\n') + 1;
	if (end <= state.length) {
		return;
	}

	const lines = markdown.slice(state.length, end).split('\n');
	lines.pop(); // the empty remainder after the last newline

	let offset = state.length;
	for (const line of lines) {
		const trimmed = line.trim();

		const fenceMatch = /^(```|~~~)/.exec(trimmed);
		if (fenceMatch) {
			if (!state.inFence) {
				state.inFence = true;
				state.fenceMarker = fenceMatch[1];
			} else if (trimmed.startsWith(state.fenceMarker)) {
				state.inFence = false;
				state.fenceMarker = '';
			}
		}

		// A block ends at a blank line once it has reached its token target,
		// mirroring the block cut.
		if (!state.inFence && trimmed === '' && state.tokens >= REASONING_BLOCK_TOKEN_TARGET) {
			// The block is fully generated now: remember the title it will render
			// with, so a later titleless block can keep showing it.
			const completedText = stripUnpairedBoldMarkers(
				dropBlockBlankLines(markdown.slice(state.blockStart, offset).split('\n')).join('\n').trim()
			);
			buildTfIdfCorpus(markdown);
			const completedTitle = deriveReasoningBlockTitle(completedText).title;
			if (completedTitle) {
				state.lastCompletedTitle = completedTitle;
			}

			offset += line.length + 1;
			state.blockStart = offset;
			state.tokens = 0;
			continue;
		}

		state.tokens += countReasoningTokens(line);
		offset += line.length + 1;
	}

	state.length = end;
	state.tail = markdown.slice(Math.max(end - PREVIEW_STATE_TAIL, 0), end);
}
