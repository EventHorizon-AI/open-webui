/**
 * Segmentation for the streaming "fade-in" effect.
 *
 * The naive `text.split(' ')` only works for space-delimited scripts, so CJK
 * (Chinese/Japanese/Korean) text ends up as one giant segment that fades in all
 * at once. This module splits text into per-word segments using
 * `Intl.Segmenter` (which understands CJK word boundaries) and falls back to a
 * grapheme-safe tokenizer when it is unavailable.
 *
 * Whitespace is returned as its own segment so callers can render it verbatim,
 * avoiding the phantom spaces the old implementation appended after every word.
 * Segments are always plain strings, so wrapping them in inline `<span>`s keeps
 * CJK line-breaking and text selection working normally.
 */

type SegmenterCtor = new (
	locales?: string | string[],
	options?: { granularity?: 'grapheme' | 'word' | 'sentence' }
) => {
	segment: (input: string) => Iterable<{ segment: string }>;
};

// Alternation order matters: a CJK code point, then a run of whitespace, then a
// run of non-CJK non-space characters. Together they cover every code point, so
// no character is ever dropped.
const FALLBACK_PATTERN =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]|\s+|[^\s\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}]+/gu;

const WHITESPACE = /^\s+$/;

let wordSegmenter: { segment: (input: string) => Iterable<{ segment: string }> } | null | undefined;

const getWordSegmenter = () => {
	if (wordSegmenter !== undefined) return wordSegmenter;

	try {
		const IntlWithSegmenter = Intl as unknown as { Segmenter?: SegmenterCtor };
		wordSegmenter = IntlWithSegmenter.Segmenter
			? new IntlWithSegmenter.Segmenter(undefined, { granularity: 'word' })
			: null;
	} catch {
		wordSegmenter = null;
	}

	return wordSegmenter;
};

export const isWhitespaceSegment = (segment: string): boolean => WHITESPACE.test(segment);

export const segmentStreamingText = (text: string): string[] => {
	if (!text) return [];

	const segmenter = getWordSegmenter();
	if (segmenter) {
		try {
			const segments: string[] = [];
			for (const { segment } of segmenter.segment(text)) {
				segments.push(segment);
			}
			return segments;
		} catch {
			// Some environments ship a partial Segmenter; fall back below.
		}
	}

	return text.match(FALLBACK_PATTERN) ?? [text];
};
