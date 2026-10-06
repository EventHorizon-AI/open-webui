/* eslint-disable no-misleading-character-class, @typescript-eslint/no-explicit-any */
// CJK-friendly emphasis for the marked version bundled with this project.
//
// CommonMark only classifies Unicode punctuation/whitespace when deciding
// whether an emphasis delimiter (`*` / `_`) can open or close a run. CJK
// characters are letters, so an emphasis run that starts or ends next to a CJK
// character or a full-width punctuation mark is often not recognized:
//
//   **中文：**测试        -> literal `**中文：**测试`
//   中文**（重点）**      -> literal `中文**（重点）**`
//
// This tokenizer override ports the fix from the `markdown-cjk-friendly`
// project (https://github.com/tats-u/markdown-cjk-friendly) to marked 9's
// emStrong rules, where the delimiters live under `rules.inline.emStrong`.
// CJK characters are treated as punctuation for flanking purposes only; the
// behaviour for every other language is untouched.

// CJK code point ranges (Han, Hiragana, Katakana, Hangul, CJK punctuation and
// related radicals/symbols). Mirrors the Unicode ranges used by
// markdown-cjk-friendly. Exported so the rich text composer's emphasis input
// rules can classify CJK exactly like this tokenizer does.
export const CJK =
	'\\u1100-\\u11ff\\u20a9\\u2329-\\u232a\\u2630-\\u2637\\u268a-\\u268f\\u2e80-\\u2e99\\u2e9b-\\u2ef3\\u2f00-\\u2fd5\\u2ff0-\\u303e\\u3041-\\u3096\\u3099-\\u30ff\\u3105-\\u312f\\u3131-\\u318e\\u3190-\\u31e5\\u31ef-\\u321e\\u3220-\\u3247\\u3250-\\ua48c\\ua490-\\ua4c6\\ua960-\\ua97c\\uac00-\\ud7a3\\ud7b0-\\ud7c6\\ud7cb-\\ud7fb\\uf900-\\ufaff\\ufe10-\\ufe19\\ufe30-\\ufe52\\ufe54-\\ufe66\\ufe68-\\ufe6b\\uff01-\\uffbe\\uffc2-\\uffc7\\uffca-\\uffcf\\uffd2-\\uffd7\\uffda-\\uffdc\\uffe0-\\uffe6\\uffe8-\\uffee\\u{16fe0}-\\u{16fe4}\\u{16ff0}-\\u{16ff6}\\u{17000}-\\u{18cda}\\u{18cff}-\\u{18d20}\\u{18d80}-\\u{18df2}\\u{18e00}-\\u{19191}\\u{191a0}-\\u{191d2}\\u{1aff0}-\\u{1aff3}\\u{1aff5}-\\u{1affb}\\u{1affd}-\\u{1affe}\\u{1b000}-\\u{1b128}\\u{1b132}\\u{1b150}-\\u{1b152}\\u{1b155}\\u{1b164}-\\u{1b168}\\u{1b170}-\\u{1b2fb}\\u{1d300}-\\u{1d356}\\u{1d360}-\\u{1d376}\\u{1f1ae}\\u{1f200}\\u{1f202}\\u{1f210}-\\u{1f219}\\u{1f21b}-\\u{1f22e}\\u{1f230}-\\u{1f231}\\u{1f237}\\u{1f23b}\\u{1f240}-\\u{1f248}\\u{1f260}-\\u{1f265}\\u{1f7da}\\u{20000}-\\u{3fffd}';

const cjkTest = new RegExp(`[${CJK}]`, 'u');
// A single character that is not a letter/digit from the CJK point of view:
// whitespace, punctuation, symbol or a CJK character itself.
const cjkPunctuation = new RegExp(`^((?![*_])[\\s\\p{P}\\p{S}${CJK}])`, 'u');

const cjkPunct = `[\\p{P}\\p{S}${CJK}]`;
const cjkPunctSpace = `[\\s\\p{P}\\p{S}${CJK}]`;
const cjkNotPunctSpace = `[^\\s\\p{P}\\p{S}${CJK}]`;

// Drop-in replacements for marked's `rules.inline.emStrong.rDelimAst` /
// `rDelimUnd` that treat CJK characters as punctuation. The capture groups keep
// the exact layout marked expects: 1-2 close, 3-4 open, 5-6 may do both.
function buildRDelimAst() {
	return new RegExp(
		`^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)${cjkPunct}(\\*+)(?=[\\s]|$)|${cjkNotPunctSpace}(\\*+)(?!\\*)(?=${cjkPunctSpace}|$)|(?!\\*)${cjkPunctSpace}(\\*+)(?=${cjkNotPunctSpace})|[\\s](\\*+)(?!\\*)(?=${cjkPunct})|(?!\\*)${cjkPunct}(\\*+)(?!\\*)(?=${cjkPunct})|${cjkNotPunctSpace}(\\*+)(?=${cjkNotPunctSpace})`,
		'gu'
	);
}

function buildRDelimUnd() {
	return new RegExp(
		`^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)${cjkPunct}(_+)(?=[\\s]|$)|${cjkNotPunctSpace}(_+)(?!_)(?=${cjkPunctSpace}|$)|(?!_)${cjkPunctSpace}(_+)(?=${cjkNotPunctSpace})|[\\s](_+)(?!_)(?=${cjkPunct})|(?!_)${cjkPunct}(_+)(?!_)(?=${cjkPunct})`,
		'gu'
	);
}

const emStrongRDelimAstCjk = buildRDelimAst();
const emStrongRDelimUndCjk = buildRDelimUnd();

/**
 * Whether the character before `src` counts as CJK. marked hands `prevChar` in
 * as a single UTF-16 code unit, so astral code points and variation sequences
 * can be clipped; recover them from `maskedSrc` when necessary.
 */
function isPrevCharCjk(prevChar: string, maskedSrc: string, src: string): boolean {
	let prevIsCjk = cjkPunctuation.test(prevChar);
	if (!prevIsCjk && prevChar) {
		const prevIdx = maskedSrc.length - src.length;
		if (prevIdx >= 1) {
			let idx = prevIdx - 1;
			let code = maskedSrc.charCodeAt(idx);
			// Variation selectors attach to the preceding base character.
			if (code >= 65024 && code <= 65038 && idx >= 1) {
				idx--;
				code = maskedSrc.charCodeAt(idx);
			}
			if ((code & 64512) === 56320 && idx >= 1) {
				const cp = maskedSrc.codePointAt(idx - 1);
				if (cp !== undefined && cp > 65535) {
					if (cp >= 917760 && cp <= 917999) prevIsCjk = true;
					else prevIsCjk = cjkTest.test(String.fromCodePoint(cp));
				}
			} else {
				prevIsCjk = cjkTest.test(String.fromCharCode(code));
			}
		}
	}
	return prevIsCjk;
}

/**
 * Whether a matched right delimiter sits directly next to CJK text. Marked
 * classifies such a match as left-only when the preceding character is
 * punctuation; next to CJK it must be allowed to close as well.
 */
function isCjkAdjacentToDelimiter(rightMatch: RegExpExecArray, clippedMaskedSrc: string): boolean {
	if (!(rightMatch[1] || rightMatch[2] || rightMatch[3] || rightMatch[4])) return false;
	const charBefore = String.fromCodePoint(rightMatch[0].codePointAt(0) as number);
	const afterPos = rightMatch.index + rightMatch[0].length;
	const charAfter =
		afterPos < clippedMaskedSrc.length
			? String.fromCodePoint(clippedMaskedSrc.codePointAt(afterPos) as number)
			: '';
	return cjkTest.test(charBefore) || cjkTest.test(charAfter);
}

export default function cjkFriendlyExtension() {
	return {
		tokenizer: {
			emStrong(this: any, src: string, maskedSrc: string, prevChar = ''): any {
				const { rules } = this;
				const match = rules.inline.emStrong.lDelim.exec(src);
				if (!match) return;
				// `_` cannot open between two alphanumerics.
				if (match[3] && prevChar.match(/[\p{L}\p{N}]/u)) return;

				const nextChar = match[1] || match[2] || '';
				const prevIsCjk = isPrevCharCjk(prevChar, maskedSrc, src);
				if (
					!nextChar ||
					!prevChar ||
					rules.inline.punctuation.exec(prevChar) ||
					prevIsCjk ||
					cjkTest.test(nextChar)
				) {
					const lLength = [...match[0]].length - 1;
					let rDelim;
					let rLength;
					let delimTotal = lLength;
					let midDelimTotal = 0;
					const endReg = match[0][0] === '*' ? emStrongRDelimAstCjk : emStrongRDelimUndCjk;
					endReg.lastIndex = 0;
					const clippedMaskedSrc = maskedSrc.slice(-1 * src.length + lLength);
					let rMatch: RegExpExecArray | null;
					while ((rMatch = endReg.exec(clippedMaskedSrc)) != null) {
						rDelim = rMatch[1] || rMatch[2] || rMatch[3] || rMatch[4] || rMatch[5] || rMatch[6];
						if (!rDelim) continue; // skip a single * in __abc*abc__
						rLength = [...rDelim].length;

						const isCjkAdjacent = isCjkAdjacentToDelimiter(rMatch, clippedMaskedSrc);
						const isLeftOnly = Boolean(rMatch[3] || rMatch[4]);
						const isBoth = Boolean(rMatch[5] || rMatch[6]);

						if (isLeftOnly && !isCjkAdjacent) {
							delimTotal += rLength;
							continue; // found another left delimiter
						}
						if (isBoth || isCjkAdjacent) {
							// CommonMark emphasis rules 9-10.
							if (lLength % 3 && !((lLength + rLength) % 3)) {
								midDelimTotal += rLength;
								continue;
							}
						}
						delimTotal -= rLength;
						if (delimTotal > 0) continue; // not enough closing delimiters yet

						// Remove extra characters. *a*** -> *a*
						rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
						const lastCharLength = (rMatch[0].codePointAt(0) as number) > 65535 ? 2 : 1;
						const raw = src.slice(0, lLength + rMatch.index + lastCharLength + rLength);

						if (Math.min(lLength, rLength) % 2) {
							const text = raw.slice(1, -1);
							return {
								type: 'em',
								raw,
								text,
								tokens: this.lexer.inlineTokens(text)
							};
						}
						const text = raw.slice(2, -2);
						return {
							type: 'strong',
							raw,
							text,
							tokens: this.lexer.inlineTokens(text)
						};
					}
				}
			}
		}
	};
}
