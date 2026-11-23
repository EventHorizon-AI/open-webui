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

// While a text token grows token by token, re-segmenting the whole token every
// frame costs O(token length) — on CJK the growing paragraph is one giant text
// token, so the fade-in effect made long replies degrade as they streamed.
// Boundaries further back than this window can no longer change as characters
// stream in, so only the window plus the new suffix is re-segmented.
const SEGMENT_WINDOW = 32;

export const createStreamingSegmenter = () => {
	let prevText = '';
	// `end` is the offset just past each segment, so a prefix of the previous
	// segmentation can be reused when the token only appends.
	let prevSegments: { segment: string; end: number }[] = [];

	const full = (text: string) => {
		const segmenter = getWordSegmenter();
		const segments: { segment: string; end: number }[] = [];
		if (segmenter) {
			try {
				let end = 0;
				for (const { segment } of segmenter.segment(text)) {
					end += segment.length;
					segments.push({ segment, end });
				}
				return segments;
			} catch {
				// Some environments ship a partial Segmenter; fall back below.
			}
		}
		let end = 0;
		for (const segment of text.match(FALLBACK_PATTERN) ?? [text]) {
			end += segment.length;
			segments.push({ segment, end });
		}
		return segments;
	};

	return (text: string): string[] => {
		if (text === prevText) return prevSegments.map((s) => s.segment);
		if (!text) {
			prevText = '';
			prevSegments = [];
			return [];
		}
		if (
			prevText.length > 0 &&
			text.length > prevText.length &&
			text.startsWith(prevText) &&
			prevSegments.length
		) {
			// Pure append: reuse every segment that ends before the unstable
			// window, and re-segment only the window plus the new suffix.
			const stableEnd = Math.max(0, prevText.length - SEGMENT_WINDOW);
			const kept: { segment: string; end: number }[] = [];
			let keptEnd = 0;
			for (const s of prevSegments) {
				if (s.end > stableEnd) break;
				kept.push(s);
				keptEnd = s.end;
			}
			const tail = full(text.slice(keptEnd)).map((s) => ({
				segment: s.segment,
				end: keptEnd + s.end
			}));
			prevSegments = [...kept, ...tail];
			prevText = text;
			return prevSegments.map((s) => s.segment);
		}
		prevSegments = full(text);
		prevText = text;
		return prevSegments.map((s) => s.segment);
	};
};
