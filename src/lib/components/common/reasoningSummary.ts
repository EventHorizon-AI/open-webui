/**
 * Reasoning summaries.
 *
 * A reasoning stream is cut into blocks at blank lines once a block reaches
 * `REASONING_SUMMARY_TOKEN_TARGET` tokens; the trailing line is withheld until
 * it completes. Titles are derived per block by pure JS (no model call) and
 * carried as their own field, so the renderer draws a bold title line above the
 * body; a block may render titleless.
 *
 * Mechanisms:
 * - candidates: structural titles pass through; sentences, clause prefixes,
 *   quotes and label tasks compete in a scored pool;
 * - verb-phrase synthesis: 状语 + 动词 + 宾语 when both edges are certain;
 * - fallback: halved soft penalties and definition titles;
 * - symbolic templates: name the work of a formula-dense block, eligible only
 *   after every natural candidate failed;
 * - forward expansion, or merge into the previous summary while it is held: a
 *   titleless tail, or a prose block that is only its own title;
 * - TextRank centrality, session IDF, MMR title diversity, extractive body;
 * - streaming invariant: a returned summary and its title are never rewritten.
 */

/** Tokens a block may hold before it is cut at the next newline. */
export const REASONING_SUMMARY_TOKEN_TARGET = 300;

/** Tokens of a block's body that stay visible before it is cut with an ellipsis. */
export const REASONING_SUMMARY_TOKEN_LIMIT = 40;

/**
 * Tokens a titleless tail block may hold and still fold into the previous
 * summary instead of becoming a block of its own.
 */
export const REASONING_SUMMARY_MERGE_TOKEN_LIMIT = 20;

/**
 * Body tokens a titleless block may add to a previous titled summary: a block's
 * visible body is cut at `REASONING_SUMMARY_TOKEN_LIMIT`, so two full blocks
 * fill this pool and the next titleless block starts on its own, while a
 * consecutive pair of formula blocks can still ride under one title.
 */
export const REASONING_SUMMARY_MERGE_POOL_TOKEN_LIMIT = 80;

/**
 * Extra tokens a titleless prose block absorbs before its title is tried again;
 * expansion counts from zero, so this is the added budget, not the region size.
 * The region still closes at the next blank line after the budget, like a base
 * block, so a paragraph boundary is never cut through.
 */
export const REASONING_SUMMARY_EXPAND_TOKEN_TARGET = 200;

/**
 * Total extra tokens expansion may absorb (three stages of 200) before the block
 * takes the ordinary titleless path. The cap keeps a run of formula lines from
 * holding one summary open, and a stage closes at a blank line, so the region
 * can pass it by its last block but never cuts a paragraph.
 */
export const REASONING_SUMMARY_EXPAND_TOKEN_LIMIT = 600;

/** Failed re-derivations a titleless block may spend before it gives up. */
const REASONING_SUMMARY_EXPAND_STAGES =
	REASONING_SUMMARY_EXPAND_TOKEN_LIMIT / REASONING_SUMMARY_EXPAND_TOKEN_TARGET;

/**
 * Tokens a title may reach before it is cut at the next comma; the cut-off part
 * is dropped.
 */
export const REASONING_SUMMARY_TITLE_TOKEN_TARGET = 6;

/**
 * A title never runs past the sentence it starts in, or past a clause dash or
 * colon: a terminator with this many tokens behind it ends the title early.
 */
const TITLE_SENTENCE_TOKEN_MIN = 3;

/**
 * Width at which a title is cut, in half-width display units: roughly 40 Chinese
 * characters or 80 English ones, which a long comma-less lead reaches first.
 */
export const REASONING_SUMMARY_TITLE_MAX_WIDTH = 80;

/** A title shorter than this is skipped and the next sentence is tried. */
const TITLE_MIN_CHARS = 2;

// ---------------------------------------------------------------------------
// Title scoring
//
// A candidate competes on the dot product of its feature vector and a weight
// table; every feature is one term of the hand-tuned scorer this replaces, and
// position breaks ties but never overrules what the phrase says.
//
// The weights were fitted with GRPO (`ReasoningSummary/`, λ_KL = 10, β = 0.1,
// run `runs/20261021-0043/lam_10`) over the same corpus pools and verified
// candidate-by-candidate against the hand-tuned scorer: `w0 · x` reproduces it
// with a worst error of 2.84e-14 on 36,173 candidates, and the frozen table's
// argmax matches the λ10 evaluation on every pool. Values are the JSON literals
// verbatim — no rounding — so a candidate on a floor keeps its ordering.
// `pen_telegraphic` is the one deliberate override (−18, fitted −12).
// ---------------------------------------------------------------------------

/** Content words past this cap no longer add specificity: a run-on is not a topic. */
const TITLE_SCORE_CONTENT_WORD_CAP = 6;

/** How much of a soft penalty survives in the fallback layer. */
const TITLE_FALLBACK_PENALTY_FACTOR = 0.5;

/** A hedged opener makes an otherwise usable fallback phrase less certain. */
const TITLE_FALLBACK_LOW_CONFIDENCE_PENALTY = 2;

/** One candidate's metadata: exactly what the scorer reads. */
type TitleCandidateMeta = {
	title: string;
	source: TitleSource;
	sentence: number;
	compressed: boolean;
	markup: boolean;
	labelMerge: boolean;
	listMerge: boolean;
	codeLabel: boolean;
};

/**
 * Feature order, one per term of the hand-tuned scorer. Every feature is 0 when
 * its term is inactive, so a vector can be read as "which terms fired".
 */
const TITLE_FEATURE_NAMES = [
	// position prior: one-hot over the twelve sources
	'src_opening',
	'src_opening_clause',
	'src_intent',
	'src_asker',
	'src_second',
	'src_later',
	'src_clause',
	'src_quote',
	'src_task',
	'src_fixup',
	'src_synthesis',
	'src_definition',
	// a title composed from the block's own work (the symbolic template layer)
	'src_template',
	// continuous position decay for non-opening candidates past sentence 1
	'pos_decay',
	// sentence centrality, masked to the sources that compete on it
	'centrality_masked',
	// specificity aggregate: capped IDF sum, capped word count, IDF loss term
	'spec_idf_sum_capped',
	'spec_content_word_count_capped',
	'spec_idf_loss',
	// a definition is scored as a flat two-content-word bonus
	'spec_definition',
	// rewards
	'title_ends_on_content_word',
	'intent_quality',
	'topics_handoff',
	// continuous run-on penalty (already a point value)
	'run_on_units',
	// penalty predicates (0/1)
	'pen_marker_only',
	'pen_code',
	'pen_formula_fragment',
	'pen_numeric_run',
	'pen_weak_label',
	'pen_frame',
	'pen_process_opener',
	'pen_process_opener_en',
	'pen_meta_cognition',
	'pen_plan_filler',
	'pen_adverb',
	'pen_framing',
	'pen_hedge_opener',
	'pen_evaluative_tail',
	'pen_question_tail',
	'pen_connective_opener',
	'pen_meta_sentence',
	'pen_step_plan',
	'pen_dangling_end',
	'pen_telegraphic',
	'pen_synthesis',
	'pen_template',
	'pen_markup',
	'pen_label_merge',
	'pen_list_merge',
	'pen_code_label',
	'pen_single_word',
	'pen_whole_block_intent',
	// fallback layer only: hedged opener on an otherwise usable phrase
	'fb_low_confidence'
] as const;

type TitleFeatureName = (typeof TITLE_FEATURE_NAMES)[number];
type TitleFeatures = Record<TitleFeatureName, number>;

/**
 * The ordinary layer's weights, frozen from `weights_final.json` of the λ_KL =
 * 10 GRPO run and copied verbatim (no rounding), so a candidate near a floor
 * keeps the ordering it was trained on. The two template terms come from Phase
 * B, which fitted that pair alone with the other 50 frozen (`ReasoningSummary/
 * runs/20261021-0456`, β = 0.1, λ_KL ∈ {0, 0.1, 1}, 400 iterations each):
 * validation picks the initialization, so 8 / −6 are fitted values, not guesses.
 */
const TITLE_SCORE_WEIGHTS: Record<TitleFeatureName, number> = {
	src_opening: 24.350479523212822,
	src_opening_clause: 2.355978405272777,
	src_intent: 20.55160022914217,
	src_asker: 18.428437167365782,
	src_second: 10.902788305767297,
	src_later: 5.708066313949306,
	src_clause: 2.692161982841677,
	src_quote: 8.512914949006843,
	src_task: 7.262186517486676,
	src_fixup: 4.0,
	src_synthesis: 18.274793196911062,
	src_definition: 22.0,
	pos_decay: -1.0651149141636573,
	centrality_masked: 6.961123635131294,
	spec_idf_sum_capped: 5.761906099240256,
	spec_content_word_count_capped: 0.8707031985716448,
	spec_idf_loss: 4.1339614760453545,
	spec_definition: 10.0,
	title_ends_on_content_word: 7.0746243999396485,
	intent_quality: 6.623031226030875,
	topics_handoff: 12.0,
	run_on_units: -0.9241588082660063,
	pen_marker_only: -100.0,
	pen_code: -32.0,
	pen_formula_fragment: -29.42772318687172,
	pen_numeric_run: -21.626159257608997,
	pen_weak_label: -14.0,
	pen_frame: -11.74418969579531,
	pen_process_opener: -20.43594649201676,
	pen_process_opener_en: -12.207602324674808,
	pen_meta_cognition: -6.036764874617417,
	pen_plan_filler: -13.781983279339613,
	pen_adverb: -4.853269141253481,
	pen_framing: -21.825382901552143,
	pen_hedge_opener: -13.987408088926182,
	pen_evaluative_tail: -12.865808246887925,
	pen_question_tail: -7.91548973965356,
	pen_connective_opener: -27.572439656049983,
	pen_meta_sentence: -30.0,
	pen_step_plan: -17.347461489203628,
	pen_dangling_end: -21.81880178509012,
	// Deliberate override of the fitted value (−12): a compressed title reads as
	// a note even when the phrase itself is good.
	pen_telegraphic: -18,
	pen_synthesis: -8.725206803088916,
	// A composed template is a fallback voice: it says what the block does, not
	// what the block says. Phase B fitted the pair by GRPO with the other 50
	// weights pinned; held-out reward peaks here and falls monotonically as
	// `src_template` leaves it (0.074415 vs 0.073099 at the λ = 0 end point), so
	// the prior is reproduced, not replaced. `pen_template` has no gradient and
	// both terms only fire together, so only their sum is identifiable. The pair
	// decides *whether* the layer speaks: a template clears the fallback floor by
	// 8.97 (with an object) or 15.08 (without).
	src_template: 8,
	pen_template: -6,
	pen_markup: -40.0,
	pen_label_merge: -20.479939652738388,
	pen_list_merge: -12.496444199912434,
	pen_code_label: -16.0,
	pen_single_word: -9.337088164678137,
	pen_whole_block_intent: -100.0,
	fb_low_confidence: -0.4608259940740133
};

/**
 * The penalties that describe *how* a phrase reads (a calculation step, a frame,
 * a process beat, the meta verb). A formula-heavy block's candidates all carry
 * one, and they are not hard rejections, so the fallback layer discounts them.
 */
const TITLE_FEATURE_SOFT: ReadonlySet<TitleFeatureName> = new Set<TitleFeatureName>([
	'pen_formula_fragment',
	'pen_numeric_run',
	'pen_frame',
	'pen_process_opener',
	'pen_process_opener_en',
	'pen_meta_cognition'
]);

// `pen_template` stays out of the soft set: the template discount is the
// composition prior itself, and halving it would make a template's fallback
// score depend on the layer that chose it, shifting its rank between the two
// pools. It keeps its full −6 in both layers, like an unrelated source prior.

/**
 * The fallback layer, derived from the ordinary table rather than fitted: the
 * ordinary score paid each soft penalty in full, so the fallback keeps
 * `w · TITLE_FALLBACK_PENALTY_FACTOR`, and a hedged opener pays the fixed extra
 * below. It reproduces the old `score − softPenalty · 0.5 − lowconfidence · 2`
 * to 1e-9 per candidate.
 */
const TITLE_FALLBACK_WEIGHTS: Record<TitleFeatureName, number> = (() => {
	const weights: Record<TitleFeatureName, number> = { ...TITLE_SCORE_WEIGHTS };
	for (const name of TITLE_FEATURE_SOFT) {
		weights[name] = weights[name] * TITLE_FALLBACK_PENALTY_FACTOR;
	}
	weights.fb_low_confidence = weights.fb_low_confidence - TITLE_FALLBACK_LOW_CONFIDENCE_PENALTY;
	return weights;
})();

/**
 * Session-level content-word weights: `idf = ln((N + 1) / (df + 1)) + 1` over
 * blocks, divided by the vocabulary mean and clamped to [floor, 1], so only a
 * repeated term loses weight and the score scale never grows.
 */
type ContentIdf = {
	/** Weight per content term, at most 1; a term absent here is neutral. */
	weights: ReadonlyMap<string, number>;
	/** Mean raw IDF of the session's vocabulary, kept for the same calibration in S3. */
	mean: number;
};

/**
 * One block, or two sharing a term, has no usable spread: a term in every block
 * says nothing about whether it is generic. Both keep the plain word count (a
 * shared constant also keeps the streaming preview off the cache).
 */
const NEUTRAL_CONTENT_IDF: ContentIdf = { weights: new Map(), mean: 1 };

const CONTENT_IDF_CACHE_LIMIT = 64;
const contentIdfCache = new Map<string, ContentIdf>();

/**
 * A shared word keeps at least this share of its unit; total movement is bounded
 * again by `TITLE_IDF_MAX_DISCOUNT`.
 */
const TITLE_IDF_WEIGHT_FLOOR = 0.6;

/**
 * The specificity term loses at most this many units (the learned weight is
 * ~5.8x this): IDF redistributes weight, it does not sink a title that already
 * carried its content. Rescaled with the learned table.
 */
const TITLE_IDF_MAX_DISCOUNT = 0.8;

/**
 * Content-word IDF over the blocks one title may see: the whole reasoning, or
 * the prefix up to the current block while streaming, so later blocks can never
 * change a returned title. Cached by corpus shape.
 */
function buildContentIdf(blocks: readonly string[]): ContentIdf {
	if (blocks.length < 3) {
		return NEUTRAL_CONTENT_IDF;
	}

	const key = `${blocks.length}:${blocks.reduce((total, block) => total + block.length, 0)}`;
	const cached = contentIdfCache.get(key);
	if (cached) {
		return cached;
	}

	const documentFrequency = new Map<string, number>();
	for (const block of blocks) {
		for (const term of new Set(contentWordTerms(block))) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}

	const count = blocks.length;
	const raw = new Map<string, number>();
	let sum = 0;
	for (const [term, df] of documentFrequency) {
		const value = Math.log((count + 1) / (df + 1)) + 1;
		raw.set(term, value);
		sum += value;
	}

	const mean = documentFrequency.size ? sum / documentFrequency.size : 1;
	const weights = new Map<string, number>();
	for (const [term, value] of raw) {
		// A rare word never earns a bonus, so the plain specificity scale stays
		// an upper bound; an absent term is neutral (weight 1).
		weights.set(term, Math.max(TITLE_IDF_WEIGHT_FLOOR, Math.min(1, value / mean)));
	}

	const idf: ContentIdf = { weights, mean };
	if (contentIdfCache.size >= CONTENT_IDF_CACHE_LIMIT) {
		contentIdfCache.clear();
	}
	contentIdfCache.set(key, idf);
	return idf;
}

/** A statement of intent reads at full quality from this many tokens. */
const TITLE_INTENT_QUALITY_TOKENS = 3;

type TitleSource =
	| 'opening'
	| 'opening-clause'
	| 'intent'
	| 'asker'
	| 'second'
	| 'later'
	| 'clause'
	| 'quote'
	| 'task'
	| 'fixup'
	| 'synthesis'
	| 'definition'
	| 'template';

/**
 * A title that opens on cognition itself ("Reconsider whether…") describes the
 * reasoning beat. The process-opener penalty covers the general case; this is
 * the extra cost of the meta verb, which would otherwise tie a concrete phrase.
 */
const TITLE_META_COGNITION_OPENER_RE = /^(?:think|reconsider|ponder|wonder|reflect|muse)\b/iu;

/** A later sentence is weaker than an earlier one; the penalty is capped so it never dominates. */
const TITLE_POSITION_SENTENCE_DECAY = 1.5;
const TITLE_POSITION_SENTENCE_DECAY_CAP = 9;

/** A run-on is not more specific than a phrase. */
const TITLE_PENALTY_RUN_ON_WORD = 5;
const TITLE_PENALTY_RUN_ON_WIDTH = 0.5;
const TITLE_PENALTY_RUN_ON_MAX = 25;

/** A score below this is not a title: the block reads without one. */
const TITLE_SCORE_FLOOR = 20;

// ---------------------------------------------------------------------------
// Fallback title layer
//
// A formula-heavy block (a derivation, an asymptotic argument, a recomputation)
// often has no candidate above the ordinary floor: every sentence carries math,
// so the formula/numeric-run/frame penalties sink all of them. A weaker title is
// better than bare body lines between summaries: it still names the beat, and
// the body below stays verbatim.
//
// The fallback re-chooses from the pool the ordinary pass built (the fallback
// score is computed alongside the ordinary one), so no sentence is collected
// twice. Only the penalties that describe *how* a phrase reads are halved; the
// hard rejections (marker-only, code, numeric fragments, fewer than two content
// words) are never discounted. `definition` candidates carry their own shape
// validation and are the one exception to the content-word count: "Define A(k)"
// names a symbol, so it is a topic even though it is one English word.
// ---------------------------------------------------------------------------

/** Half the ordinary floor: a fallback title has to be a phrase, not noise. */
const TITLE_SCORE_FLOOR_FALLBACK = TITLE_SCORE_FLOOR / 2;

const TITLE_FALLBACK_LOW_CONFIDENCE_RE =
	/^(?:maybe|perhaps|probably|possibly|sort of|kind of|i think|i guess|it seems|it looks)\b/iu;

/**
 * Pure commentary between calculations ("Makes sense", "That jumped a lot") is
 * not a topic. It passes the content-word count but would read as a junk title,
 * so the fallback rejects it and lets the block merge instead.
 */
const TITLE_FALLBACK_ASIDE_RE =
	/^(?:makes? sense|of course|interesting|that(?:'s| is) (?:interesting|weird|strange|right|correct|wrong)|that jumped|weird|strange|nice|good|great|okay|ok|hmm+|wait|hold on|right|yes|no)\b/iu;

/**
 * A title that *is* an equation ("G(t) = (t − 2√2)·H(t) positive roots") still
 * reads as a formula fragment after the halved penalty, so the fallback rejects
 * that shape and lets the block merge; an equation inside a sentence is fine.
 * Only a symbol or function call followed directly by a relation operator is
 * rejected.
 */
const TITLE_FALLBACK_FORMULA_STATEMENT_RE =
	/^\p{L}[\p{L}\p{N}_]*(?:\s*\([^)]*\))?\s*(?:=|:=|≈|≠|≤|≥|<|>)/u;

// ---------------------------------------------------------------------------
// Title diversity across blocks
//
// A title is chosen against the titles already final in this call. The penalty
// only reorders the pool, so it never creates or removes a title line.
// ---------------------------------------------------------------------------

/** Cosine above which two titles read as the same topic. */
const TITLE_DIVERSITY_SIMILARITY = 0.6;

/**
 * Full penalty at cosine 1; an identical title is discounted by this much.
 * Rescaled x~1.6 with the learned weight table, whose priors sit ~1.6x above the
 * hand-set ones, so fixed tie-break points keep their score-scale weight.
 */
const TITLE_PENALTY_DIVERSITY = 19;

/**
 * A diverse candidate must beat the base winner's adjusted score by this much
 * before it replaces it, so a converged title that is genuinely ahead is not
 * traded for a marginal gain; an identical title's penalty is larger than the
 * margin, so a real tie still yields.
 */
const TITLE_DIVERSITY_MARGIN = 5;

/** A title's content-word bag, used only for the diversity comparison. */
type TitleBag = {
	terms: ReadonlySet<string>;
	norm: number;
};

function titleBag(title: string): TitleBag {
	const terms = new Set(titleContentWordTerms(title));
	return { terms, norm: Math.sqrt(terms.size) };
}

/** Binary-bag cosine: shared terms over the geometric mean of the bag sizes. */
function titleBagSimilarity(a: TitleBag, b: TitleBag): number {
	if (a.norm === 0 || b.norm === 0) {
		return 0;
	}
	const [small, large] = a.terms.size <= b.terms.size ? [a, b] : [b, a];
	let shared = 0;
	for (const term of small.terms) {
		if (large.terms.has(term)) {
			shared++;
		}
	}
	return shared / (a.norm * b.norm);
}

/**
 * Penalty against the chosen titles:
 * `max over p [ sim > threshold ? D · (sim − threshold) / (1 − threshold) : 0 ]`,
 * with `sim` the cosine of the content-word bags. `chosen` holds earlier blocks
 * only, so streaming can never rewrite an earlier title.
 */
function titleDiversityPenalty(
	terms: ReadonlySet<string>,
	norm: number,
	chosen: readonly TitleBag[]
): number {
	if (!chosen.length || norm === 0) {
		return 0;
	}

	const bag: TitleBag = { terms, norm };
	let most = 0;
	for (const previous of chosen) {
		const similarity = titleBagSimilarity(bag, previous);
		if (similarity > most) {
			most = similarity;
		}
	}
	if (most <= TITLE_DIVERSITY_SIMILARITY) {
		return 0;
	}
	return (
		TITLE_PENALTY_DIVERSITY *
		((most - TITLE_DIVERSITY_SIMILARITY) / (1 - TITLE_DIVERSITY_SIMILARITY))
	);
}

// ---------------------------------------------------------------------------
// Continuation anchor
//
// A block opening on a pronoun or connective ("So…", "这…") usually continues
// the previous block: a candidate sharing a content word with the previous title
// earns a small bonus, so the thread is kept instead of drifting.
// ---------------------------------------------------------------------------

// Chinese openers are whole words at the sentence start, so they need no
// boundary; English openers are token-matched, so "so" cannot eat "source".
const TITLE_CONTINUATION_OPENERS_ZH = [
	'这个方案',
	'该方法',
	'接下来',
	'所以',
	'因此',
	'于是',
	'那么',
	'这样',
	'这么',
	'这个',
	'这种',
	'这些',
	'那些',
	'那个',
	'这里',
	'上述',
	'上面',
	'然后',
	'接着',
	'同时',
	'另外',
	'此外',
	'不过',
	'但是',
	'然而',
	'它们',
	'他们',
	'她们',
	'这',
	'那',
	'它',
	'他',
	'她',
	'该',
	'此',
	'其',
	'但'
].sort((a, b) => b.length - a.length);

const TITLE_CONTINUATION_OPENERS_EN = [
	'therefore',
	'instead',
	'anyway',
	'anyhow',
	'however',
	'again',
	'these',
	'those',
	'this',
	'that',
	'they',
	'them',
	'their',
	'thus',
	'hence',
	'then',
	'also',
	'next',
	'now',
	'its',
	'but',
	'and',
	'it',
	'so'
];

const TITLE_CONTINUATION_OPENER_RE = new RegExp(
	`^(?:${TITLE_CONTINUATION_OPENERS_ZH.join('|')}|(?:${TITLE_CONTINUATION_OPENERS_EN.join('|')})\\b)`,
	'iu'
);

/**
 * A candidate title that names the previous topic; the full anchor bonus.
 * Rescaled with the learned weight table (was 2 at the hand-set scale).
 */
const TITLE_SCORE_CONTINUATION = 3.2;

/** Only the source sentence shares the previous topic; half the bonus. */
const TITLE_SCORE_CONTINUATION_SOURCE = 1.6;

const EMPTY_TITLE_TERMS: ReadonlySet<string> = new Set<string>();

/**
 * Whether the block's first content-bearing sentence opens on a continuation
 * marker; discourse markers in front of it are skipped.
 */
function opensWithContinuation(blockText: string): boolean {
	for (const sentence of splitSentences(blockText.replace(/\n/g, ' '))) {
		const trimmed = sentence.text.trim();
		if (
			!trimmed ||
			isDiscourseMarkerOnly(trimmed) ||
			LIST_ITEM_RE.test(trimmed) ||
			/^(?:```|~~~|\|)/u.test(trimmed)
		) {
			continue;
		}
		return TITLE_CONTINUATION_OPENER_RE.test(trimmed);
	}
	return false;
}

/**
 * The anchor bonus sits below the ordinary position gaps and abstains when
 * the previous block has no title. A source-sentence match earns half, so a
 * pronoun-only phrase can still be preferred.
 */
function titleContinuationBonus(
	title: string,
	sourceText: string,
	priorTitleTerms: ReadonlySet<string>
): number {
	if (!priorTitleTerms.size) {
		return 0;
	}
	for (const term of titleContentWordTerms(title)) {
		if (priorTitleTerms.has(term)) {
			return TITLE_SCORE_CONTINUATION;
		}
	}
	for (const term of contentWordTerms(sourceText)) {
		if (priorTitleTerms.has(term)) {
			return TITLE_SCORE_CONTINUATION_SOURCE;
		}
	}
	return 0;
}

/** The title context threaded through one draft: what was already chosen. */
type TitleContext = {
	/** Titles of the blocks before this one, in block order. */
	chosenTitles: readonly TitleBag[];
	/** Content words of the immediately previous block's title, or empty. */
	priorTitleTerms: ReadonlySet<string>;
};

/** Clause prefixes beyond this many per sentence add cost, not insight. */
const TITLE_CLAUSE_CANDIDATE_LIMIT = 6;

/**
 * Synthesis is the most expensive candidate (it segments the whole sentence),
 * and the lead plus one stated task carry almost every usable phrase.
 */
const TITLE_SYNTHESIS_ATTEMPT_LIMIT = 3;

// Characters that occupy two half-width cells in a monospace-like layout.
const WIDE_CLASS =
	'\\u1100-\\u115F\\u2E80-\\uA4CF\\uAC00-\\uD7A3\\uF900-\\uFAFF\\uFE10-\\uFE19\\uFE30-\\uFE6F\\uFF00-\\uFF60\\uFFE0-\\uFFE6';

const WIDE_CHAR_RE = new RegExp(`[${WIDE_CLASS}]`, 'u');

// Deliberately simple tokenizer: two wide (CJK, Kana, Hangul, full-width)
// characters count one token, other runs about one per four characters. It
// sizes display blocks; it does not reproduce a model's vocabulary.
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

// Word-level matching for the Chinese cleanup: the platform segmenter knows
// 目的, 了解 and 存在 are words, so a particle table can be consulted with whole
// segments. `Intl.Segmenter` is required (there is no char-scanning fallback);
// token counting stays on the character tokenizer, which is a hot path.
const WORD_SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });

type WordSegment = {
	word: string;
	start: number;
	/** Index just past the segment. */
	end: number;
	isWordLike: boolean;
};

// Segmenting is the expensive part of every title pass and the same text is
// segmented several times. The module-level cache is bounded and cleared
// wholesale, so memory stays independent of stream length.
const WORD_SEGMENT_CACHE_LIMIT = 200;
const wordSegmentCache = new Map<string, WordSegment[]>();

function segmentWords(text: string): WordSegment[] {
	const cached = wordSegmentCache.get(text);
	if (cached) {
		return cached;
	}

	const segments: WordSegment[] = [];
	for (const part of WORD_SEGMENTER.segment(text)) {
		segments.push({
			word: part.segment,
			start: part.index,
			end: part.index + part.segment.length,
			isWordLike: part.isWordLike === true
		});
	}

	if (wordSegmentCache.size >= WORD_SEGMENT_CACHE_LIMIT) {
		wordSegmentCache.clear();
	}
	wordSegmentCache.set(text, segments);
	return segments;
}

/** The words of `text`, without whitespace and punctuation segments. */
function wordSegments(text: string): WordSegment[] {
	return segmentWords(text).filter((part) => part.isWordLike);
}

// English prose goes through its own token layer: words, contractions and
// hyphen compounds. A contraction stays whole, so the alias table below splits
// the ones the function-word table must judge; hyphens are merged back into one
// word so "state-of-the-art" is never read as "of" and "the".
const ENGLISH_SEGMENTER = new Intl.Segmenter('en', { granularity: 'word' });
const ENGLISH_TOKEN_CACHE_LIMIT = 200;
const englishTokenCache = new Map<string, EnglishToken[]>();

type EnglishToken = {
	/** Surface text as written. */
	text: string;
	/** Lower-case lookup form, with curly apostrophes normalised to `'`. */
	lower: string;
	start: number;
	end: number;
	word: boolean;
};

function normalizeEnglishWord(text: string): string {
	return text.toLowerCase().replace(/[’‘]/gu, "'");
}

function englishTokens(text: string): EnglishToken[] {
	const cached = englishTokenCache.get(text);
	if (cached) {
		return cached;
	}

	const tokens: EnglishToken[] = [];
	for (const part of ENGLISH_SEGMENTER.segment(text)) {
		if (!part.isWordLike) {
			continue;
		}

		const start = part.index;
		const end = start + part.segment.length;
		const previous = tokens.at(-1);
		// A hyphen with no space around it joins the compound back into one
		// token, so the function table sees no "of"/"the".
		if (previous && /^[-‐]$/u.test(text.slice(previous.end, start))) {
			previous.text = text.slice(previous.start, end);
			previous.lower = normalizeEnglishWord(previous.text);
			previous.end = end;
			continue;
		}

		tokens.push({
			text: part.segment,
			lower: normalizeEnglishWord(part.segment),
			start,
			end,
			word: true
		});
	}

	if (englishTokenCache.size >= ENGLISH_TOKEN_CACHE_LIMIT) {
		englishTokenCache.clear();
	}
	englishTokenCache.set(text, tokens);
	return tokens;
}

/** Whether only whitespace separates two words (no punctuation or code). */
function isWhitespaceGap(text: string, before: { end: number }, after: { start: number }): boolean {
	return /^\s*$/u.test(text.slice(before.end, after.start));
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
 * appending an ellipsis when anything was dropped; the last piece keeps the
 * characters that fit, so a long run is never reduced to just the ellipsis.
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

export type ReasoningSummary = {
	/** Derived title, or '' when the block is its own title. */
	title: string;
	/** Body plain text under the title; rendered by the template, not pre-assembled. */
	body: string;
	/** Whether the body was cut at the token limit. */
	truncated: boolean;
};

/**
 * Whether `text` already reads as summary markdown: a bold `**{title}**` line
 * followed by its body, displayed as written instead of being rebuilt. This is
 * for reasoning that already carries rendered titles (an old chat, another
 * model's output); the builder returns title and body separately.
 */
export function isReasoningSummaryMarkdown(text: string): boolean {
	const lines = text.split(/\r?\n/);
	let index = 0;
	while (index < lines.length && lines[index].trim() === '') {
		index++;
	}

	const title = /^\s*\*\*(.+?)\*\*\s*$/.exec(lines[index] ?? '');
	if (!title || !title[1].trim()) {
		return false;
	}

	// A lone bold line is a heading, not a rendered summary: the title has to
	// carry content on the next line.
	return (lines[index + 1] ?? '').trim() !== '';
}

export type BuildReasoningSummaryOptions = {
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
	 * The title abridges its source (a filler lifted, function words or
	 * punctuation dropped, a width cut). The body keeps the original text
	 * unless the title still reproduces the whole consumed region.
	 */
	abridged: boolean;
};

/**
 * A prose candidate with its score. `source`/`sentence` carry the position
 * prior; `compressed` records that function words were deleted to fit (the
 * telegraphic fallback), and `markup` that it started on a heading or label.
 */
type EnhancedCandidate = TitleCandidate & {
	score: number;
	/**
	 * The same candidate under the fallback layer (soft penalties halved),
	 * computed with the ordinary score in one pass so a titleless block can
	 * re-choose from the pool it already built.
	 */
	fallbackScore: number;
	source: TitleSource;
	sentence: number;
	compressed: boolean;
	markup: boolean;
	/** The title runs across a label colon into the list item behind it. */
	labelMerge: boolean;
	/** The title runs across a list separator, gluing list items together. */
	listMerge: boolean;
	/** The title is a caption ending on a colon that introduces a code block. */
	codeLabel: boolean;
};

type ProseCandidate = TitleCandidate & { compressed: boolean };

const NO_TITLE: TitleCandidate = { title: '', consumed: 0, abridged: false };

const LIST_ITEM_RE = /^(?:[-*+]|\d+[.)])\s+\S/;

// Every opener a title does not need: conversational fillers ("好的，…"),
// sequencing words ("首先", "Next,"), bare modals ("need to") and leading
// quantifiers ("一些"). One dataset, shared by the leading strip and the
// Chinese function-word table; matching is by word segment, so a repeated beat
// ("嗯嗯", "hmm hmm") folds into one marker.
type TitleLeadMarker = {
	text: string;
	/**
	 * An interjection only reads as filler when punctuation or whitespace closes
	 * it: "好友…" keeps 好, "好的，…" loses it.
	 */
	interjection?: boolean;
};

const TITLE_LEAD_MARKERS: ReadonlyArray<TitleLeadMarker> = [
	// Interjections, acknowledgements and praise.
	{ text: 'okay', interjection: true },
	{ text: 'ok', interjection: true },
	{ text: 'sure', interjection: true },
	{ text: 'alright', interjection: true },
	{ text: 'yeah', interjection: true },
	{ text: 'yes', interjection: true },
	{ text: 'hmm', interjection: true },
	{ text: 'hm', interjection: true },
	{ text: 'wait', interjection: true },
	{ text: 'great', interjection: true },
	{ text: 'good', interjection: true },
	{ text: 'nice', interjection: true },
	{ text: 'perfect', interjection: true },
	{ text: 'excellent', interjection: true },
	{ text: '好的', interjection: true },
	{ text: '好吧', interjection: true },
	{ text: '好', interjection: true },
	{ text: '嗯', interjection: true },
	{ text: '呃', interjection: true },
	{ text: '是的', interjection: true },
	{ text: '对的', interjection: true },
	{ text: '没错', interjection: true },
	{ text: '没问题', interjection: true },
	{ text: '明白了', interjection: true },
	{ text: '明白', interjection: true },
	{ text: '可以', interjection: true },
	// English sequencing and discourse connectives.
	{ text: 'firstly' },
	{ text: 'first' },
	{ text: 'secondly' },
	{ text: 'second' },
	{ text: 'third' },
	{ text: 'finally' },
	{ text: 'lastly' },
	{ text: 'then' },
	{ text: 'next' },
	{ text: 'now' },
	{ text: 'also' },
	{ text: 'so' },
	{ text: 'well' },
	{ text: 'basically' },
	{ text: 'actually' },
	{ text: 'and' },
	{ text: 'but' },
	{ text: 'since' },
	// Chinese sequencing, connectives and summary openers.
	{ text: '进一步' },
	{ text: '总结下来' },
	{ text: '总结来说' },
	{ text: '总的来说' },
	{ text: '总而言之' },
	{ text: '简单来说' },
	{ text: '换句话说' },
	{ text: '综上所述' },
	{ text: '综上' },
	{ text: '首先' },
	{ text: '其次' },
	{ text: '然后' },
	{ text: '接着' },
	{ text: '接下来' },
	{ text: '之后' },
	{ text: '最后' },
	{ text: '现在' },
	{ text: '那么' },
	{ text: '所以' },
	{ text: '因此' },
	{ text: '另外' },
	{ text: '此外' },
	{ text: '同时' },
	{ text: '再次' },
	{ text: '再' },
	{ text: '不过' },
	{ text: '但是' },
	{ text: '可是' },
	{ text: '然而' },
	{ text: '而且' },
	{ text: '并且' },
	{ text: '而' },
	{ text: '但' },
	{ text: '总之' },
	{ text: '或者说' },
	{ text: '或者' },
	{ text: '甚至' },
	{ text: '尤其' },
	{ text: '例如' },
	// Leading fillers: "一些用户要求…" -> "用户要求…", "some logs" -> "logs".
	// 帮忙 is what a request leaves behind once the asker is lifted: "用户让我帮忙
	// 设计…" -> "设计…".
	{ text: '帮忙' },
	{ text: '一些' },
	{ text: '一下' },
	{ text: 'some' },
	// Bare modals: "需要检查…" -> "检查…", "need to check…" -> "check…".
	{ text: 'need to' },
	{ text: 'needs to' },
	{ text: 'needed to' },
	{ text: 'have to' },
	{ text: 'has to' },
	{ text: 'had to' },
	{ text: 'want to' },
	{ text: 'wants to' },
	{ text: 'wanted to' },
	{ text: 'ought to' },
	{ text: 'used to' },
	{ text: 'plan to' },
	{ text: 'plans to' },
	{ text: 'planned to' },
	{ text: '还要' },
	{ text: '需要' },
	{ text: '应该' },
	{ text: '应当' },
	{ text: '必须' },
	{ text: '得' },
	{ text: '打算' },
	{ text: '要' },
	{ text: '还' }
];

type LeadMarkerFamily = 'beat' | 'latin' | 'han';

// How a marker family ends and repeats. The scan below is one loop; the family
// decides the boundary, so the table needs no per-entry logic:
// - `beat`: interjections; punctuation closes them and a run of the same beat
//   ("嗯嗯", "hmm hmm") is consumed as one marker;
// - `latin`: ASCII words ending at the word boundary, so "so" cannot eat
//   "source" and "well" cannot eat "well-formed";
// - `han`: bare Chinese words, whose segment is the boundary.
type LeadMarkerFamilyRule = {
	/** Punctuation or the end of the text must follow the marker. */
	closedBoundary: boolean;
	/** The marker repeats without punctuation as one beat. */
	repeatedBeat: boolean;
};

const LEAD_MARKER_FAMILIES: Record<LeadMarkerFamily, LeadMarkerFamilyRule> = {
	beat: { closedBoundary: true, repeatedBeat: true },
	latin: { closedBoundary: true, repeatedBeat: false },
	han: { closedBoundary: false, repeatedBeat: false }
};

type PreparedLeadMarker = { marker: TitleLeadMarker; words: string[]; family: LeadMarkerFamily };

function leadMarkerFamily(marker: TitleLeadMarker): LeadMarkerFamily {
	if (marker.interjection) {
		return 'beat';
	}
	return /^[A-Za-z0-9]/u.test(marker.text) ? 'latin' : 'han';
}

// Longest first, so "明白了" wins over "明白", "好的" over "好" and "need to"
// over "need". A marker is matched by its own word segments.
const TITLE_LEAD_MARKERS_BY_LENGTH: ReadonlyArray<PreparedLeadMarker> = TITLE_LEAD_MARKERS.map(
	(marker) => ({
		marker,
		words: wordSegments(marker.text).map((part) => part.word),
		family: leadMarkerFamily(marker)
	})
).sort((a, b) => b.words.length - a.words.length || b.marker.text.length - a.marker.text.length);

// Buckets by the marker's first word: only a marker starting with that word can
// match, so the scan is a handful of entries instead of the whole table.
const TITLE_LEAD_MARKER_INDEX = new Map<string, PreparedLeadMarker[]>();
for (const entry of TITLE_LEAD_MARKERS_BY_LENGTH) {
	const first = entry.words[0]?.toLowerCase();
	if (!first) {
		continue;
	}
	const bucket = TITLE_LEAD_MARKER_INDEX.get(first);
	if (bucket) {
		bucket.push(entry);
	} else {
		TITLE_LEAD_MARKER_INDEX.set(first, [entry]);
	}
}

// The Chinese words the marker pass owns. The function-word table drops these
// entries so the same wording is not maintained twice.
const CHINESE_LEAD_MARKER_WORDS = new Set(
	TITLE_LEAD_MARKERS.map((marker) => marker.text).filter((word) =>
		/^[\p{Script=Han}]+$/u.test(word)
	)
);

const TITLE_LEAD_MARKER_PUNCT_RE = /^[\s,，、.。!！?？;；:：~～]+/u;

// "嗯嗯" is one segment, "hmm hmm" is two: both are the same beat repeated.
function isRepeatedToken(token: string, unit: string): boolean {
	if (!unit || token.length <= unit.length || token.length % unit.length !== 0) {
		return false;
	}
	return token.toLowerCase() === unit.toLowerCase().repeat(token.length / unit.length);
}

// One marker at the start of `words`: its words must match in order,
// case-insensitively and without punctuation between them. A one-word interjection
// may itself be the first repeated beat ("嗯嗯"), which the run scan below folds.
function matchLeadMarkerWords(
	text: string,
	words: readonly WordSegment[],
	entry: PreparedLeadMarker
): { lastMatched: number; firstRepeated: boolean } | null {
	let firstRepeated = false;
	for (let i = 0; i < entry.words.length; i++) {
		const word = words[i];
		if (
			i === 0 &&
			entry.family === 'beat' &&
			entry.words.length === 1 &&
			isRepeatedToken(word.word, entry.words[0])
		) {
			firstRepeated = true;
			continue;
		}
		if (word.word.toLowerCase() !== entry.words[i].toLowerCase()) {
			return null;
		}
		if (i > 0 && !isWhitespaceGap(text, words[i - 1], word)) {
			return null;
		}
	}
	return { lastMatched: entry.words.length - 1, firstRepeated };
}

// An interjection can repeat without punctuation ("嗯嗯，", "hmm hmm"): the run is
// one beat, so the marker is consumed as a whole. Repeats separated by
// punctuation are picked up by the strip loop instead.
function extendLeadMarkerBeat(
	text: string,
	words: readonly WordSegment[],
	entry: PreparedLeadMarker,
	lastMatched: number
): number {
	for (;;) {
		const start = lastMatched + 1;
		const end = start + entry.words.length;
		if (end > words.length) {
			return lastMatched;
		}
		for (let i = 0; i < entry.words.length; i++) {
			const word = words[start + i];
			const previous = words[start + i - 1];
			if (
				word.word.toLowerCase() !== entry.words[i].toLowerCase() ||
				(previous && !isWhitespaceGap(text, previous, word))
			) {
				return lastMatched;
			}
		}
		lastMatched = end - 1;
	}
}

function leadMarkerClosesAt(rule: LeadMarkerFamilyRule, next: string): boolean {
	return !rule.closedBoundary || next === '' || TITLE_LEAD_MARKER_PUNCT_RE.test(next);
}

// Matches a marker at the very start of `text` against its word segments.
function matchTitleLeadMarker(text: string): { marker: TitleLeadMarker; length: number } | null {
	const words = wordSegments(text);
	if (!words.length || words[0].start !== 0) {
		return null;
	}

	const entries = TITLE_LEAD_MARKER_INDEX.get(words[0].word.toLowerCase()) ?? [];
	for (const entry of entries) {
		if (words.length < entry.words.length) {
			continue;
		}
		const match = matchLeadMarkerWords(text, words, entry);
		if (!match) {
			continue;
		}

		const rule = LEAD_MARKER_FAMILIES[entry.family];
		const lastMatched =
			rule.repeatedBeat && !match.firstRepeated
				? extendLeadMarkerBeat(text, words, entry, match.lastMatched)
				: match.lastMatched;
		const length = words[lastMatched].end;
		if (leadMarkerClosesAt(rule, text[length] ?? '')) {
			return { marker: entry.marker, length };
		}
	}
	return null;
}

// Lifts opener after opener off a title source. Each marker takes the punctuation
// behind it, so a Chinese comma cannot survive in front of the new first word.
// A strip that would leave less than a usable title is refused.
function stripLeadingDiscourseMarkers(text: string): { text: string; abridged: boolean } {
	let current = text;
	let abridged = false;

	for (;;) {
		const match = matchTitleLeadMarker(current);
		if (!match) {
			break;
		}

		const rest = current.slice(match.length).replace(TITLE_LEAD_MARKER_PUNCT_RE, '').trimStart();
		if (Array.from(rest).length < TITLE_MIN_CHARS || rest === current) {
			break;
		}

		current = rest;
		abridged = true;
	}

	return { text: current, abridged };
}

// Structural framing a title does not need, stripped repeatedly so nested
// framing unwinds: pointless lead-ins, first-person lead-ins, summarizing
// lead-ins and labels. What remains is the task itself.
const TITLE_PREAMBLE_RES: RegExp[] = [
	// Pointless lead-ins: 需要注意的是，缓存… -> 缓存…, 关键的一点是… -> …
	// 是/就是 keep a guard against 是否: the copula cannot be lifted out of the
	// word "whether" and leave 否 as the title.
	/^(?:最?重要|需要|值得|重点|关键|问题|结论)(?:注意|说明|强调|指出|留意|关注)?(?:的?(?:一点|地方|之处))?(?:的)?(?:是|在于|就是)(?!否)[，,]?\s*/,
	// 让我看看… / 让我们试试… without a subject.
	/^让我们?/,
	// Hedges: 我觉得缓存有问题 -> 缓存有问题.
	/^(?:我)?(?:觉得|认为|猜测|推断|估计|发现|注意到|意识到|看到|明白|理解)/,
	// Summarizing lead-ins: "the key insight is finding…" -> "finding…";
	// "the main point is that the cache…" -> "the cache…"; the noun can be
	// absent ("the key is recognizing…", "the issue is that I misidentified…").
	/^(?:the |a |an )?(?:key|critical|core|central|main|important|essential|fundamental|real|biggest|issue|problem|thing|reason|point|part|trick|catch)(?:\s+(?:insight|point|takeaway|idea|lesson|conclusion|thing|answer|question|issue|problem|challenge|trick|catch|part|aspect|factor|consideration))?(?: here)? (?:is|lies in) (?:that |about )?/i,
	// A sentence-y opener that only says something is something: "This is a
	// tricky problem." -> "tricky problem".
	/^(?:this|that|it) (?:is|was|seems|looks)(?: like)? (?:an |a |the )?/i,
	// The step a solution labels itself with: "Step 1: Calculate…" -> "Calculate…".
	/^step\s*\d+\s*[:.)、]?\s*/i,
	// The reasoning's checklist: "evaluate each option for moving water…" ->
	// "moving water…"; the connector is required, so a label that continues
	// ("evaluate each option against what is known…") stays whole and reads as
	// the checklist it is.
	/^(?:evaluate|consider|assess|review|examine|analyze|analyse|check|list|go through|look at|work through)\s+(?:each|every|all|the)\s+(?:of\s+)?(?:the\s+)?(?:options?|choices?|answers?|alternatives?|possibilit(?:y|ies)|sentences?|statements?|items?|cases?|steps?|values?|numbers?)\s+(?:for|to|about)\s+/iu,
	// A bare checklist ("evaluate each option") strips to nothing; that is the
	// answer — there is no topic behind it.
	/^(?:evaluate|consider|assess|review|examine|analyze|analyse|check|list|go through|look at|work through)\s+(?:each|every|all|the)\s+(?:of\s+)?(?:the\s+)?(?:options?|choices?|answers?|alternatives?|possibilit(?:y|ies)|sentences?|statements?|items?|cases?|steps?|values?|numbers?)\s*[:：]?\s*(?=$)/iu,
	// "Here's the classification for each food:" -> "classification for each food".
	// The article alternation keeps a word boundary, so "the" cannot be lifted
	// out of "theorem" (or "a"/"an" out of "analysis").
	/^here(?:['’]s| is| are| was| were)(?: the| a| an| my| our)?\b\s*/i,
	// The asker in Spanish: "El usuario pide un poema…" -> "un poema…". The verb
	// boundary keeps "es" out of "está" and "espera" out of "esperanza".
	/^(?:el|la)\s+(?:usuario|pregunta|problema|tarea|ejercicio)\s+(?:pide|quiere|necesita|solicita|espera|dice|pregunta|es)\b(?:\s+que)?\s*/iu,
	// Noticing lead-ins: "I see that the cache…" -> "the cache…".
	/^(?:i|we) (?:notice|noticed|see|saw|realize|realized|find|found|understand|understood|think|thought|guess|assume|assumed|remember) (?:that )?/i,
	// Holding something in hand: "We have f(x) = …, defined for…" -> "f(x) = …".
	/^(?:i|we) (?:have|has|had|get|got|obtain|obtained|know|note|noticed?|recall|remember|see|find|found)(?: that)?\s+/i,
	// Framing before the task: "Looking at this problem, I need to find…" ->
	// "find…". The noun boundary keeps "problem" out of "problems".
	/^(?:looking at|reading|re-reading) (?:this|the) (?:problem|question|equation|expression|task|scenario|situation)\b[,]?\s*/i,
	// First-person lead-ins: "I need to check…" -> "check…".
	/^(?:i|we)(?:'m|'re| am| are) going to /i,
	/^(?:i|we) (?:need|needs|needed|have|has|had|want|wants|wanted|ought|used|plan|plans|planned|aim|aims|aimed|intend|intends|intended|seek|seeks|sought|strive|strives|strove|attempt|attempts|attempted|try|tries|tried|hope|hopes|hoped|decide|decides|decided|expect|expects|expected|manage|manages|managed) to /i,
	/^(?:i|we)(?:'ll|'d|'m|'re|'ve| will| would| should| must| shall| can| could| may| might| have| has| had| am| are) /i,
	/^let(?:'s| us| me) /i
];

// Words that add nothing to a title wherever they sit: 获取一些信息 -> 获取信息,
// "check some logs" -> "check logs". The leading occurrences are handled by
// TITLE_LEAD_MARKERS.
const TITLE_FILLER_RE = /(?:一些|一下)|\bsome\s+(?=\p{L})/giu;

// Quote pairs a lead may carry, with the mark that opens them. An apostrophe
// opens a quote only when it does not sit inside a word ("the user's").
const TITLE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['“', '”'],
	['『', '』'],
	['「', '」'],
	['‘', '’'],
	['"', '"'],
	["'", "'"]
];

// Any quote mark the pairing scans below care about. Most titles carry none,
// and the scans run per candidate and per edge, so they bail out first.
const QUOTE_MARKS = new Set(TITLE_QUOTE_PAIRS.flatMap(([open, close]) => [open, close]));
const QUOTE_MARK_RE = new RegExp(`[${[...QUOTE_MARKS].join('')}]`, 'u');

// A mark that only looks like a quote inside a word ("What's", "students'").
// While a quote is open the mark can still close it, so a word character after
// it is required too.
function isWordApostrophe(text: string, index: number, mark: string, quoteOpen: boolean): boolean {
	if (mark !== "'" && mark !== '’') {
		return false;
	}
	const previous = text[index - 1] ?? '';
	const next = text[index + 1] ?? '';
	if (!/[\p{Script=Latin}\p{N}]/u.test(previous)) {
		return false;
	}
	return !quoteOpen || /[\p{Script=Latin}\p{N}]/u.test(next);
}

/**
 * Positions of quote marks that have no partner; a word-internal apostrophe is
 * not a quote mark. When one is left over, the mark at the text's own edge is
 * the truncation artifact.
 */
function unpairedQuoteMarkPositions(text: string): Set<number> {
	const unpaired = new Set<number>();
	if (!QUOTE_MARK_RE.test(text)) {
		return unpaired;
	}

	for (const [open, close] of TITLE_QUOTE_PAIRS) {
		if (open === close) {
			const positions: number[] = [];
			let pending = false;
			for (let i = text.indexOf(open); i !== -1; i = text.indexOf(open, i + open.length)) {
				if (isWordApostrophe(text, i, open, pending)) {
					continue;
				}
				positions.push(i);
				pending = !pending;
			}
			if (positions.length % 2 === 1) {
				const first = positions[0];
				const last = positions[positions.length - 1];
				const firstAtEdge = first === 0;
				const lastAtEdge = last + open.length === text.length;
				unpaired.add(lastAtEdge || !firstAtEdge ? last : first);
			}
			continue;
		}

		let pending = -1;
		for (let i = 0; i < text.length; i++) {
			if (text.startsWith(open, i)) {
				if (pending === -1) {
					pending = i;
				}
				i += open.length - 1;
				continue;
			}
			if (!text.startsWith(close, i)) {
				continue;
			}
			if (isWordApostrophe(text, i, close, pending !== -1)) {
				i += close.length - 1;
				continue;
			}
			if (pending === -1) {
				unpaired.add(i);
			} else {
				pending = -1;
			}
			i += close.length - 1;
		}
		if (pending !== -1) {
			unpaired.add(pending);
		}
	}

	return unpaired;
}

// Stray marks at either edge of a title source: a marker or punctuation left
// in front of the lead ("✓.", "!"), a heading marker that survived a broken
// bold label ("**## Title **…"), or a truncated quote.
//
// The leading set also holds closers with no opener in the title: a block cut
// mid-expression can start a span on the orphan `)` of `(1/u-1/v?)`. Sentence
// splitting now keeps a bracketed group whole, so this case no longer reaches a
// title, but an expansion window or a structural cut can still begin on a
// leftover closer; a title that opens on one is noise, not a phrase. Only the
// closers are listed: an opening bracket belongs to the expression it starts.
const TITLE_EDGE_LEADING_MARKS_RE = /^[\s#.*_~…。！？；：，、;:!?,～\-—–"'“”‘’✓✗✔)\]})）】｝]+/u;
const TITLE_EDGE_TRAILING_MARKS_RE = /[\s.*_~…。！？；：，、;:!?,～\-—–"'“”‘’✓✗✔]+$/u;

/**
 * Removes stray marks at one edge, but keeps a quote mark that still pairs with
 * one inside the text: only an unpaired mark is a truncation artifact, and
 * removing one end of a pair would strand the other.
 */
function stripTitleEdgeMarks(text: string, edge: 'leading' | 'trailing'): string {
	const run =
		edge === 'leading'
			? TITLE_EDGE_LEADING_MARKS_RE.exec(text)?.[0]
			: TITLE_EDGE_TRAILING_MARKS_RE.exec(text)?.[0];
	if (!run) {
		return text;
	}

	// A run with no quote mark is ordinary punctuation: strip it whole without
	// running the pairing scan.
	if (![...run].some((char) => QUOTE_MARKS.has(char))) {
		return edge === 'leading' ? text.slice(run.length) : text.slice(0, text.length - run.length);
	}

	const unpaired = unpairedQuoteMarkPositions(text);
	let cut = edge === 'leading' ? 0 : text.length;

	for (let offset = 0; offset < run.length; offset++) {
		const index = edge === 'leading' ? offset : text.length - 1 - offset;
		const char = text[index];
		if (!QUOTE_MARKS.has(char)) {
			cut = edge === 'leading' ? index + 1 : index;
			continue;
		}

		if (!unpaired.has(index)) {
			break;
		}
		cut = edge === 'leading' ? index + 1 : index;
	}

	return edge === 'leading' ? text.slice(cut) : text.slice(0, cut);
}

// Quoted content longer than this (6 words, or 12 CJK characters) is what the
// block is about: the quote titles instead of the sentence carrying it.
const TITLE_QUOTE_TOKEN_TARGET = 6;

// First quoted span of the line longer than the quote target, or null. `end`
// points just past the closing mark, so consuming through it lifts the quote.
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

			// Code punctuation, not a quote: a real quoted span does not open on a
			// clause separator or close on an opening bracket. Skip the pair and
			// keep scanning — a real quote may follow.
			if (/^[，、；：,;:]/.test(inner) || /[（【《([{]$/.test(inner)) {
				i = closeIndex + close.length - 1;
				break;
			}

			if (countReasoningTokens(inner) > TITLE_QUOTE_TOKEN_TARGET) {
				return { text: inner, end: closeIndex + close.length };
			}

			// Too short to title with: skip past the closing mark so it cannot
			// open the next span and swallow the prose between two quotes.
			i = closeIndex + close.length - 1;
			break;
		}
	}

	return null;
}

// Where a cut structural title may break: word spaces plus clause and CJK
// sentence separators, so the continuation starts at a fresh word or clause.
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
			.replace(/\*\*(.+?)\*\*/g, '$1')
			.replace(/__(.+?)__/g, '$1')
			// A bold marker left unpaired by a broken label ("**## Title **rest")
			// is a markdown artifact, not part of the title.
			.replace(/\*\*/g, '')
			.replace(/~~(.+?)~~/g, '$1')
			.replace(/\s+/g, ' ')
			.trim()
	);
}

// Unwinds structural framing: each pass strips the first matching preamble, so
// labels stack without one combined pattern per combination. A strip that would
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
				// A pure checklist ("evaluate each option") strips to nothing:
				// that is the answer — there is no topic behind it.
				if (next.length === 0 && TOPIC_CHECKLIST_RE.test(text)) {
					text = next;
					stripped = true;
					break;
				}
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

// The Chinese half of the asker frame, matched on word segments: 问题, 说明 and
// 会议 are single segments, so a verb cannot fire inside them. The segmenter
// merges some role pairs ("我想", "的是"), so an alias table expands those back.
const CHINESE_ASKER_SUBJECTS = new Set([
	'用户',
	'我',
	'我们',
	'咱们',
	'你',
	'你们',
	'他',
	'她',
	'他们',
	'它'
]);

const CHINESE_ASKER_TIMES = new Set([
	'现在',
	'正在',
	'马上',
	'先',
	'刚刚',
	'刚才',
	'又',
	'还',
	'也',
	'就',
	'在',
	'再',
	// A modal adverb names the asker's attitude, not the task: 用户可能希望…
	'可能'
]);

const CHINESE_ASKER_VERBS = new Set([
	'要求',
	'请求',
	'希望',
	'想要',
	'想',
	'需要',
	'要',
	'让',
	'叫',
	'请',
	'询问',
	'问',
	'说',
	'打算',
	'准备',
	'计划',
	'应该',
	'应当',
	'必须',
	'可以',
	'得',
	'将',
	'会',
	'来'
]);

const CHINESE_ASKER_NOUNS = new Set([
	'问题',
	'疑问',
	'目标',
	'需求',
	'任务',
	'目的',
	'意图',
	'诉求',
	'请求',
	'计划'
]);

const CHINESE_ASKER_COPULAS = new Set(['是', '在于', '就是', '是想']);

const CHINESE_ASKER_COMPLEMENT_PRONOUNS = new Set(['我', '我们', '你', '你们', '他们', '它']);

const CHINESE_ASKER_VERB_SUFFIXES = new Set(['知道', '了解', '问']);

// Some verbs merge with the action behind them ("想用", "想做"). The merged
// segment is split only when its tail is one of these verbs, so 想法 stays whole.
const CHINESE_ASKER_VERB_TAILS = new Set([
	'用',
	'把',
	'将',
	'做',
	'写',
	'看',
	'说',
	'找',
	'学',
	'试',
	'改',
	'查',
	'画',
	'读',
	'算',
	'实现',
	'设计',
	'开发',
	'创建',
	'生成'
]);

// Longest verb first, so 想要 wins over 想 when both are a prefix of a segment.
const CHINESE_ASKER_VERB_PREFIXES = [...CHINESE_ASKER_VERBS].sort((a, b) => b.length - a.length);

const CHINESE_ASKER_ALIASES = new Map<string, string[]>();
for (const prefix of [...CHINESE_ASKER_SUBJECTS, ...CHINESE_ASKER_TIMES]) {
	for (const verb of CHINESE_ASKER_VERBS) {
		const combined = `${prefix}${verb}`;
		if (wordSegments(combined).length === 1) {
			CHINESE_ASKER_ALIASES.set(combined, [prefix, verb]);
		}
	}
}
// The cleft form "…问的是…" and "…想的是…" leaves the copula inside the
// complement; both words are one segment there.
CHINESE_ASKER_ALIASES.set('的是', ['的', '是']);

type FramePiece = { text: string; start: number; end: number };

// Splits the words of `text` into grammar roles: an aliased token becomes its
// two words, every other word stays one piece.
function framePieces(text: string): FramePiece[] {
	const pieces: FramePiece[] = [];
	for (const word of wordSegments(text)) {
		const alias = CHINESE_ASKER_ALIASES.get(word.word);
		if (!alias) {
			pieces.push({ text: word.word, start: word.start, end: word.end });
			continue;
		}
		let offset = word.start;
		for (const part of alias) {
			pieces.push({ text: part, start: offset, end: offset + part.length });
			offset += part.length;
		}
	}
	return pieces;
}

function framePieceIs(
	pieces: FramePiece[],
	index: number,
	allowed: ReadonlySet<string>,
	text: string,
	previous?: FramePiece
): boolean {
	const piece = pieces[index];
	if (!piece || !allowed.has(piece.text)) {
		return false;
	}
	return !previous || isWhitespaceGap(text, previous, piece);
}

// The cleft and the trailing copula run: [的|地|是] each, in this order.
const CHINESE_ASKER_FRAME_TAILS: ReadonlyArray<string> = ['的', '地', '是'];

// Every shape of the verb frame: subject and time are optional, tried subject
// first and with-time before without. The order is the match order.
const CHINESE_ASKER_FRAME_SHAPES: ReadonlyArray<{ subject: boolean; time: boolean }> = [
	{ subject: true, time: true },
	{ subject: true, time: false },
	{ subject: false, time: true },
	{ subject: false, time: false }
];

// A frame piece that is exactly `word` and separated from the piece before it.
function framePieceAt(
	pieces: FramePiece[],
	index: number,
	word: string,
	text: string,
	previous?: FramePiece
): boolean {
	const piece = pieces[index];
	return piece?.text === word && (!previous || isWhitespaceGap(text, previous, piece));
}

// The problem named as a noun: 用户的问题是X -> X.
function matchAskerNounFrame(pieces: FramePiece[], text: string): number | null {
	if (!framePieceIs(pieces, 0, CHINESE_ASKER_SUBJECTS, text)) {
		return null;
	}
	let previous = pieces[0];
	let index = 1;
	if (framePieceAt(pieces, index, '的', text, previous)) {
		previous = pieces[index];
		index++;
	}
	if (!framePieceIs(pieces, index, CHINESE_ASKER_NOUNS, text, previous)) {
		return null;
	}
	previous = pieces[index];
	index++;
	if (!framePieceIs(pieces, index, CHINESE_ASKER_COPULAS, text, previous)) {
		return null;
	}
	return consumeFrameComma(text, pieces[index].end);
}

// The verb a piece starts with; a merged verb+action ("想用", "想把") counts only
// when its tail is an action, so 想法 stays a noun.
function askerVerbText(piece: FramePiece): string | undefined {
	return CHINESE_ASKER_VERB_PREFIXES.find(
		(verb) =>
			piece.text.startsWith(verb) &&
			(piece.text === verb || CHINESE_ASKER_VERB_TAILS.has(piece.text.slice(verb.length)))
	);
}

// [subject] [time] verb [suffix] [pronoun] [的|地|是] [,]
function matchAskerVerbFrame(pieces: FramePiece[], text: string): number | null {
	for (const shape of CHINESE_ASKER_FRAME_SHAPES) {
		let index = 0;
		let previous: FramePiece | undefined;
		if (shape.subject) {
			if (!framePieceIs(pieces, index, CHINESE_ASKER_SUBJECTS, text)) {
				continue;
			}
			previous = pieces[index++];
		}
		if (shape.time) {
			if (!framePieceIs(pieces, index, CHINESE_ASKER_TIMES, text, previous)) {
				continue;
			}
			previous = pieces[index++];
		}

		const verbPiece = pieces[index];
		if (!verbPiece || (previous && !isWhitespaceGap(text, previous, verbPiece))) {
			continue;
		}
		const verbText = askerVerbText(verbPiece);
		if (!verbText) {
			continue;
		}
		index++;

		// The rest of a merged verb+action segment ("想用", "想把") is where
		// the object starts: the frame ends inside that segment.
		if (verbPiece.text !== verbText) {
			return consumeFrameComma(text, verbPiece.start + verbText.length);
		}

		// 想知道 / 想了解 / 想问 keeps the verb it usually takes.
		if (
			(verbText === '想' || verbText === '想要') &&
			framePieceIs(pieces, index, CHINESE_ASKER_VERB_SUFFIXES, text, verbPiece)
		) {
			index++;
		}

		let tail = pieces[index - 1];
		if (framePieceIs(pieces, index, CHINESE_ASKER_COMPLEMENT_PRONOUNS, text, tail)) {
			tail = pieces[index];
			index++;
		}
		for (const part of CHINESE_ASKER_FRAME_TAILS) {
			if (framePieceAt(pieces, index, part, text, tail)) {
				tail = pieces[index];
				index++;
			}
		}
		return consumeFrameComma(text, tail.end);
	}
	return null;
}

// The Chinese frame families, tried in order: the noun frame first, then the
// verb shapes. Every piece is a whole word segment, so a verb cannot fire
// inside 问题 or 说明.
const CHINESE_ASKER_FRAMES: ReadonlyArray<(pieces: FramePiece[], text: string) => number | null> = [
	matchAskerNounFrame,
	matchAskerVerbFrame
];

// The end of a Chinese asker frame at the start of `text`, or null.
function matchChineseAskerFrame(text: string): number | null {
	const pieces = framePieces(text);
	if (!pieces.length) {
		return null;
	}
	for (const frame of CHINESE_ASKER_FRAMES) {
		const end = frame(pieces, text);
		if (end !== null) {
			return end;
		}
	}
	return null;
}

// The comma a frame may carry before its object, with the whitespace behind it.
function consumeFrameComma(text: string, end: number): number {
	return end + (/^\s*[，,]?\s*/u.exec(text.slice(end))?.[0].length ?? 0);
}

// "the user's question is about X" -> "X".
const ENGLISH_ASKER_NOUN_FRAME_RE =
	/^(?:the\s+)?(?:user(?:'s)?|person(?:'s)?)\s+(?:question|problem|request|task)(?:\s+(?:is|was))?\s+(?:about|regarding|that)\s+/iu;

// One pattern for the English subject and verb group ("the user wants to…",
// "the problem clearly says…"). The trailing connector lets the object start.
//
// The verb is required: an asker with no statement verb is not a frame, only a
// subject ("the user is…"). Every stem that optional groups or a bare
// separator class follow carries a word boundary, so a verb cannot be cut out
// of a longer word: `says?` must not bite "saying" (leaving "ing" as the
// object), `do` must not bite "doing", `that` must not bite "that's", and the
// pronoun/article/scenario stems cannot bite "messages", "formatting",
// "theorem" or "cases".
const ENGLISH_ASKER_FRAME_RE =
	/^(?:the|this|that)\s+(?:user|person|questioner|asker|enquirer|inquirer|problem|question|task|prompt|request|message)(?:'s)?(?:\s+(?:is|are|was|were|seems to be|appears to be|clearly|just|also))?\s+(?:asking|asks?|asked|wondering|wonders|requesting|requests?|inquiring|inquires|enquiring|would like|wants?|wanted|needs?|needed|requires?|required|states?|stated|says?|said|mentions?|mentioned|expects?|expected|describes?|presents?|introduces?|sets? up)\b(?:\s+(?:me|us)\b)?(?:\s+(?:for|about|regarding)\b)?(?:\s+(?:an?|the)\b)?(?:\s+(?:scenario|situation|case|story)\b)?(?:\s+(?:to\s+(?:identify|determine|explain|describe|say|tell|state|find|calculate|compute|write|provide|answer|handle|do)\b|where\b|in which\b|that\b|about\b|for\b|to\b|regarding\b))?[ ,:：]*/iu;

// Lifts the asker and its request off a title source, leaving the object that
// titles. A frame whose strip would leave less than a usable title is refused.
function stripAskerFrame(text: string): { text: string; abridged: boolean } {
	let current = text;
	let abridged = false;

	for (;;) {
		const chineseEnd = matchChineseAskerFrame(current);
		const english =
			chineseEnd === null
				? (ENGLISH_ASKER_NOUN_FRAME_RE.exec(current) ?? ENGLISH_ASKER_FRAME_RE.exec(current))
				: null;
		const end = chineseEnd ?? (english ? english[0].length : null);
		if (end === null) {
			break;
		}

		const rest = current.slice(end).trimStart();
		if (Array.from(rest).length < TITLE_MIN_CHARS || rest === current) {
			break;
		}

		current = rest;
		abridged = true;
	}

	return { text: current, abridged };
}

// Function words a lead never ends on: such a title was cut mid-thought, so the
// ending is dropped with the separators it leaves. Dangling words chain, so the
// strip repeats.
const TITLE_DANGLING_ENDING_RE =
	/(?:可能|应该|需要|比如|例如|或者|得到|在于|包括|的话|要|还|也|都|就|又|再|并|而|但|是|的|了|着|过|与|和|及|或)+$/u;
// A lead can also end mid-clause on an English relative ("…the type of a
// variable that has"): the relative with its verb is dropped.
const TITLE_DANGLING_RELATIVE_RE =
	/(?:\s+(?:that|which|who)\s+(?:has|have|had|is|are|was|were|does|do|did|can|could|will|would|shall|should|may|might|must))$/iu;
const TITLE_TRAILING_SEPARATORS_RE = /[\s.*_~…。！？；：，、;:!?,～\-—–]+$/u;

function stripDanglingTitleEnding(title: string): string {
	let text = title;

	for (;;) {
		const next = text
			.replace(TITLE_DANGLING_ENDING_RE, '')
			.replace(TITLE_DANGLING_RELATIVE_RE, '')
			.replace(TITLE_TRAILING_SEPARATORS_RE, '')
			.trimEnd();

		if (next === text || Array.from(next).length < TITLE_MIN_CHARS) {
			return text;
		}

		text = next;
	}
}

// Cleans a title source and reports whether it abridges what it covers. The body
// uses that to keep the original text instead of skipping it.
function cleanTitleSource(raw: string): { title: string; abridged: boolean } {
	let text = stripInlineMarkdown(raw.replace(/^>\s?/, ''));

	// Stray marks in front of a lead ("✓.", "!") would hide the framing behind
	// them; a heading marker that survived a broken bold label is a stray mark
	// too. A quote comes off here only when it has no partner, so a quoted phrase
	// is never split.
	text = stripTitleEdgeMarks(text, 'leading');
	let abridged = false;

	const withoutLeadMarkers = stripLeadingDiscourseMarkers(text);
	if (withoutLeadMarkers.abridged) {
		abridged = true;
		text = withoutLeadMarkers.text;
	}

	// Order matters: filler words are removed before the asker frame so
	// "一些用户要求…" still reads as the asker to strip.
	text = text.replace(TITLE_FILLER_RE, '');

	const withoutAsker = stripAskerFrame(text);
	if (withoutAsker.abridged) {
		abridged = true;
		text = withoutAsker.text;
	}

	// The asker frame can uncover a marker ("用户让我帮忙设计…" -> "帮忙设计…"):
	// the lead strip runs again so an opener behind it is not left in the title.
	const afterAskerMarkers = stripLeadingDiscourseMarkers(text);
	if (afterAskerMarkers.abridged) {
		abridged = true;
		text = afterAskerMarkers.text;
	}

	const withoutPreamble = stripTitlePreamble(text);
	if (withoutPreamble !== text) {
		abridged = true;
		text = withoutPreamble;
	}

	let beforeDangling = text.replace(TITLE_FILLER_RE, '');
	beforeDangling = stripTitleEdgeMarks(beforeDangling, 'leading');
	beforeDangling = stripTitleEdgeMarks(beforeDangling, 'trailing');
	beforeDangling = beforeDangling.replace(/\s+/g, ' ').trim();
	const title = stripDanglingTitleEnding(beforeDangling);

	// Dropping a dangling ending ("输出格式的话" -> "输出格式") abridges what
	// the title covers, so the body must keep the original clause.
	return { title, abridged: abridged || title !== beforeDangling };
}

// A spaced dash between short math terms is subtraction, not clause punctuation
// ("t - 2√2", "(x - k)/x"): it does not end a title. A multi-letter word before
// the dash ("biases - creating") still separates clauses.
function isSubtractionDash(before: string, after: string): boolean {
	return (
		/(?:^|[\s([{)\]}])(?:\(?\p{L}[\p{N}\u2070-\u209f]?\)?)$/u.test(before) &&
		/^[\p{L}\d]/u.test(after)
	);
}

// A title cut is a pair of offsets: the title ends at `titleEnd`, the source is
// consumed through `consumed` (a step marker's own length is consumed too).
type TitleCut = { titleEnd: number; consumed: number };

// Sentence punctuation ends a lead after a short phrase; a clause separator
// needs the full title target. A lookup keeps the per-character test flat.
const TITLE_SOFT_CUT_CHARS: ReadonlySet<string> = new Set([
	'.',
	'。',
	'!',
	'！',
	'?',
	'？',
	':',
	'：',
	'-',
	'–',
	'—'
]);

// A step marker inside the lead ("Jar A = 28 marbles Step 2: Calculate…")
// begins the next step, not the title.
function stepMarkerCut(text: string, i: number): TitleCut | null {
	const char = text[i];
	if (char !== 's' && char !== 'S') {
		return null;
	}
	if (i > 0 && !/\s/.test(text[i - 1] ?? '')) {
		return null;
	}
	if (countReasoningTokens(text.slice(0, i)) < TITLE_SENTENCE_TOKEN_MIN) {
		return null;
	}
	const step = /^step\s*\d+\s*[:.)、]?\s*/iu.exec(text.slice(i));
	return step ? { titleEnd: i, consumed: i + step[0].length } : null;
}

// The cut one boundary position offers, or null to walk on. A Chinese comma is
// a sentence boundary on its own; an ASCII comma that only follows a verb or
// two is a list separator; a subtraction dash is not clause punctuation; every
// other boundary still has to reach its token target.
function titleCutAt(text: string, i: number): TitleCut | null {
	const char = text[i];
	if (!isTitleBoundary(text, i)) {
		return null;
	}
	if (char === '，') {
		return { titleEnd: i, consumed: i + 1 };
	}
	if (char === ',' && titleContentWordCount(text.slice(0, i)) < 2) {
		return null;
	}
	if (
		(char === '-' || char === '–' || char === '—') &&
		/\s/u.test(text[i - 1] ?? '') &&
		/\s/u.test(text[i + 1] ?? '')
	) {
		const before = /(\S+)\s*$/u.exec(text.slice(0, i))?.[1] ?? '';
		const after = /^\s*(\S+)/u.exec(text.slice(i + 1))?.[1] ?? '';
		if (isSubtractionDash(before, after)) {
			return null;
		}
	}
	const target = TITLE_SOFT_CUT_CHARS.has(char)
		? TITLE_SENTENCE_TOKEN_MIN
		: REASONING_SUMMARY_TITLE_TOKEN_TARGET;
	return countReasoningTokens(text.slice(0, i)) >= target ? { titleEnd: i, consumed: i + 1 } : null;
}

// A title is a lead: count tokens the way blocks are cut, and once the target is
// reached cut at the next punctuation. The cut-off part is dropped; punctuation
// inside math or inline code does not end a title.
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
		if (inMath) {
			continue;
		}

		const step = stepMarkerCut(text, i);
		if (step) {
			return { title: text.slice(0, step.titleEnd).trimEnd(), consumed: step.consumed };
		}
		const cut = titleCutAt(text, i);
		if (cut) {
			return { title: text.slice(0, cut.titleEnd), consumed: cut.consumed };
		}
	}

	return { title: text, consumed: text.length };
}

const TITLE_BOUNDARY_CHARS = '，、；：。！？…';

// Sentence and clause punctuation; an ASCII period only when it ends the text or
// is followed by whitespace and is not a decimal separator.
function isTitleBoundary(text: string, i: number): boolean {
	const char = text[i];
	if (TITLE_BOUNDARY_CHARS.includes(char) || ',;!?'.includes(char)) {
		return true;
	}

	if (char === ':') {
		const prev = text[i - 1] ?? '';
		const next = text[i + 1] ?? '';
		return !(/\d/.test(prev) && /\d/.test(next)) && next !== '/';
	}

	if (char === '.') {
		const prev = text[i - 1] ?? '';
		const next = text[i + 1] ?? '';
		if (/\d/.test(prev) && /\d/.test(next)) {
			return false;
		}
		if (next !== '' && !/\s/.test(next)) {
			return false;
		}
		// "vs.", "e.g.", "Dr." — an abbreviation dot never ends a title.
		return !isAbbreviationDot(text, i);
	}

	// A dash with whitespace on both sides separates a title from its subtitle, so
	// it ends the title too. An attached dash ("state—such") stays part of the text.
	if (char === '-' || char === '–' || char === '—') {
		if (!(/\s/.test(text[i - 1] ?? '') && /\s/.test(text[i + 1] ?? ''))) {
			return false;
		}
		// "x - y = 4" and "x³ - y³": a dash between single-letter terms is a
		// subtraction, not a subtitle separator, so it stays inside the title.
		const before = /(\S+)\s+$/u.exec(text.slice(0, i));
		if (before && /^\p{L}[\p{N}\u2070-\u209f]?$/u.test(before[1])) {
			return false;
		}
		return true;
	}

	return false;
}

// English leads drop syntactic glue: articles, copulas, auxiliaries, the
// expletive "it"/"that" and the infinitive "to" — only where the word is glue.
// The table and its word-sequence predicates live below.

// A KaTeX math span: display "$$…$$", inline "$…$", "\\(…\\)" and "\\[…\\]".
const MATH_SPAN_RE = /\$\$[\s\S]*?\$\$|\$[^$\n]*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/gu;

// Runs the transform only on the prose around math spans, so a variable in
// "a^2" is never read as an article and "\\to" keeps its word.
function mapOutsideMath(text: string, transform: (prose: string) => string): string {
	let result = '';
	let last = 0;
	for (const range of protectedTitleRanges(text)) {
		if (range.start < last || range.start >= range.end) {
			continue;
		}
		result += transform(text.slice(last, range.start));
		result += text.slice(range.start, range.end);
		last = range.end;
	}
	return result + transform(text.slice(last));
}

// Quote pairs an inline quote may use. An apostrophe is never one of them: it
// sits inside words ("the user's").
const INLINE_QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['“', '”'],
	['「', '」'],
	['『', '』'],
	['"', '"']
];

// The ranges of a title that are not prose: KaTeX spans and quoted spans. A
// quote whose closing mark is missing protects to the end, so its words survive
// cleaning verbatim; the unpaired mark itself is dropped later.
function protectedTitleRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	for (const match of text.matchAll(MATH_SPAN_RE)) {
		const start = match.index ?? 0;
		ranges.push({ start, end: start + match[0].length });
	}

	for (let i = 0; i < text.length; i++) {
		for (const [open, close] of INLINE_QUOTE_PAIRS) {
			if (!text.startsWith(open, i)) {
				continue;
			}
			// A quote never opens inside a Latin word: the `'` or `"` there is
			// an apostrophe or a closing mark ("the user's", "sāvakā"). A CJK
			// character does not block the opener — 是"Hello" starts a quote.
			if (/[\p{Script=Latin}\p{N}]/u.test(text[i - 1] ?? '')) {
				continue;
			}
			const closeAt = text.indexOf(close, i + open.length);
			ranges.push({ start: i, end: closeAt === -1 ? text.length : closeAt + close.length });
			i = (closeAt === -1 ? text.length : closeAt + close.length) - 1;
			break;
		}
	}

	ranges.sort((a, b) => a.start - b.start);
	return ranges;
}

// A cut or an edge cleanup can leave a quote mark without its partner: that is a
// truncation artifact, so it comes off. Paired quotes stay — they mark a phrase.
// A mark inside a word is an apostrophe and is never counted.
function dropUnpairedQuoteMarks(title: string): string {
	let text = title;

	for (;;) {
		const unpaired = [...unpairedQuoteMarkPositions(text)].sort((a, b) => b - a);
		if (unpaired.length === 0) {
			return text;
		}
		for (const index of unpaired) {
			text = text.slice(0, index) + text.slice(index + 1);
		}
	}
}

// Math delimiters read as plain text in the finished title (the LaTeX source
// stays): KaTeX would render asynchronously and grow the block late. They are
// removed last, and a few operator macros are spelled out as their symbol.
function stripMathDelimiters(text: string): string {
	return text
		.replace(/\$\$([\s\S]*?)\$\$/gu, '$1')
		.replace(/\$([^$\n]*?)\$/gu, '$1')
		.replace(/\\\[([\s\S]*?)\\\]/gu, '$1')
		.replace(/\\\(([^)]*?)\\\)/gu, '$1')
		.replace(/\\cdot\b/gu, '·')
		.replace(/\\times\b/gu, '×')
		.replace(/\\div\b/gu, '÷')
		.replace(/\\pm\b/gu, '±');
}

// ---------------------------------------------------------------------------
// English function words
//
// A closed-class table consulted at word-segment level; context rules are
// word-sequence predicates, not lookarounds embedded in the table.
// ---------------------------------------------------------------------------

type EnglishFunctionKind =
	/** Glue wherever it appears. */
	| 'always'
	/** Expletive "it"; kept as a pronoun before a subordinator or an auxiliary. */
	| 'it'
	/** Infinitive "to"; kept after a catenative verb or a complement. */
	| 'to'
	/** Auxiliary "have"; kept before a quantity ("have two", "have the"). */
	| 'have'
	/** Auxiliary "do"; kept before a preposition or a negation, and after "to". */
	| 'do'
	/** Complementizer "that"; a relative connector after a noun is kept. */
	| 'that'
	/** The indefinite article carries the phrase ("a positive base"); held. */
	| 'article-a'
	/** A finite copula; kept only where it is the relative clause's own verb. */
	| 'be'
	/** The base, perfect and progressive forms are held ("be able to"). */
	| 'be-base';

type EnglishFunctionWord = {
	word: string;
	kind: EnglishFunctionKind;
};

const ENGLISH_FINITE_BE_FORMS: ReadonlyArray<string> = ['is', 'are', 'was', 'were', 'am'];
const ENGLISH_BE_BASE_FORMS: ReadonlyArray<string> = ['be', 'been', 'being'];
const ENGLISH_BE_FORMS: ReadonlyArray<string> = [
	...ENGLISH_FINITE_BE_FORMS,
	...ENGLISH_BE_BASE_FORMS
];
const ENGLISH_HAVE_FORMS: ReadonlyArray<string> = ['have', 'has', 'had'];
const ENGLISH_DO_FORMS: ReadonlyArray<string> = ['do', 'does', 'did'];

const ENGLISH_FUNCTION_WORDS: ReadonlyArray<EnglishFunctionWord> = [
	{ word: 'an', kind: 'always' },
	{ word: 'the', kind: 'always' },
	{ word: 'there', kind: 'always' },
	{ word: 'its', kind: 'always' },
	{ word: 'it', kind: 'it' },
	{ word: 'to', kind: 'to' },
	{ word: 'that', kind: 'that' },
	{ word: 'a', kind: 'article-a' },
	...ENGLISH_HAVE_FORMS.map((word) => ({ word, kind: 'have' as const })),
	...ENGLISH_DO_FORMS.map((word) => ({ word, kind: 'do' as const })),
	...ENGLISH_FINITE_BE_FORMS.map((word) => ({ word, kind: 'be' as const })),
	...ENGLISH_BE_BASE_FORMS.map((word) => ({ word, kind: 'be-base' as const }))
];

const ENGLISH_FUNCTION_WORD_INDEX = new Map<string, EnglishFunctionWord>(
	ENGLISH_FUNCTION_WORDS.map((entry) => [entry.word, entry])
);

// The contraction forms the segmenter hands back whole; the alias is the word
// sequence behind it. A negative contraction ("don't") is never deleted.
const ENGLISH_CONTRACTION_ALIASES: ReadonlyMap<string, readonly string[]> = new Map([
	["i'll", ['i', 'will']],
	["i'm", ['i', 'am']],
	["i'd", ['i', 'would']],
	["i've", ['i', 'have']],
	["we'll", ['we', 'will']],
	["we're", ['we', 'are']],
	["we'd", ['we', 'would']],
	["we've", ['we', 'have']],
	["it's", ['it', 'is']],
	["that's", ['that', 'is']],
	["don't", ['do', 'not']],
	["doesn't", ['does', 'not']],
	["didn't", ['did', 'not']],
	["can't", ['can', 'not']],
	["won't", ['will', 'not']],
	["isn't", ['is', 'not']],
	["aren't", ['are', 'not']],
	["wasn't", ['was', 'not']],
	["weren't", ['were', 'not']]
]);

const ENGLISH_CONTRACTION_FUNCTION_PARTS = new Set([
	'i',
	'we',
	'it',
	'that',
	'is',
	'am',
	'are',
	'will',
	'would',
	'have',
	'has',
	'had'
]);

function isEnglishFunctionContraction(lower: string): boolean {
	const alias = ENGLISH_CONTRACTION_ALIASES.get(lower);
	return !!alias && alias.every((part) => ENGLISH_CONTRACTION_FUNCTION_PARTS.has(part));
}

// A phrase is deleted whole: judged one word at a time, "be able to" would leave
// "be" behind because "to" before "be" is kept.
const ENGLISH_FUNCTION_PHRASES: ReadonlyArray<readonly string[]> = [
	...ENGLISH_BE_FORMS.map((form) => [form, 'able', 'to'] as const),
	...ENGLISH_HAVE_FORMS.map((form) => [form, 'to', 'be'] as const)
];

const ENGLISH_FUNCTION_PHRASE_INDEX = new Map<string, Array<readonly string[]>>();
for (const phrase of ENGLISH_FUNCTION_PHRASES) {
	const bucket = ENGLISH_FUNCTION_PHRASE_INDEX.get(phrase[0]);
	if (bucket) {
		bucket.push(phrase);
	} else {
		ENGLISH_FUNCTION_PHRASE_INDEX.set(phrase[0], [phrase]);
	}
}

// "to" survives after a catenative verb ("want to go"), an adjective complement
// ("accessible to people") and a wh-word ("how to parse"); modals and base "be"
// stay in the title.
const ENGLISH_CATENATIVE_VERBS = new Set([
	'want',
	'wants',
	'wanted',
	'aim',
	'aims',
	'aimed',
	'intend',
	'intends',
	'intended',
	'seek',
	'seeks',
	'sought',
	'strive',
	'strives',
	'strove',
	'attempt',
	'attempts',
	'attempted',
	'need',
	'needs',
	'needed',
	'try',
	'tries',
	'tried',
	'plan',
	'plans',
	'planned',
	'hope',
	'hopes',
	'hoped',
	'decide',
	'decides',
	'decided',
	'expect',
	'expects',
	'expected',
	'seem',
	'seems',
	'seemed',
	'appear',
	'appears',
	'appeared',
	'tend',
	'tends',
	'tended',
	'fail',
	'fails',
	'failed',
	'manage',
	'manages',
	'managed',
	'promise',
	'promises',
	'promised',
	'ask',
	'asks',
	'asked',
	'afford',
	'affords',
	'afforded',
	'learn',
	'learns',
	'learned',
	'choose',
	'chooses',
	'chose',
	'mean',
	'means',
	'meant',
	'start',
	'starts',
	'started',
	'begin',
	'begins',
	'began',
	'continue',
	'continues',
	'continued',
	'like',
	'likes',
	'liked',
	'prefer',
	'prefers',
	'preferred',
	'forget',
	'forgets',
	'forgot',
	'remember',
	'remembers',
	'remembered',
	'offer',
	'offers',
	'offered',
	'agree',
	'agrees',
	'agreed',
	'refuse',
	'refuses',
	'refused',
	'pretend',
	'pretends',
	'pretended',
	'claim',
	'claims',
	'claimed',
	'happen',
	'happens',
	'happened',
	'struggle',
	'struggles',
	'struggled',
	'prepare',
	'prepares',
	'prepared',
	'arrange',
	'arranges',
	'arranged',
	'dare',
	'dares',
	'dared',
	'help',
	'helps',
	'helped',
	'going',
	'gonna',
	'used',
	'able',
	'ought'
]);

const ENGLISH_WH_WORDS = new Set([
	'what',
	'how',
	'when',
	'where',
	'which',
	'whether',
	'who',
	'why'
]);
const ENGLISH_SUBORDINATORS = new Set([
	'how',
	'that',
	'whether',
	'when',
	'where',
	'why',
	'if',
	'and',
	'but',
	'or',
	'because',
	'so',
	'which',
	'who'
]);
const ENGLISH_AUXILIARIES = new Set([
	'might',
	'may',
	'will',
	'would',
	'shall',
	'should',
	'can',
	'could',
	'must',
	'do',
	'does',
	'did',
	'has',
	'have',
	'had',
	'need',
	'needs',
	'is',
	'are',
	'was',
	'were',
	'am'
]);
// A finite copula is the verb of a relative clause after these subjects
// ("what day of the week it was"); deleting it leaves the clause headless.
const ENGLISH_BE_SUBJECTS = new Set([
	'it',
	'that',
	'which',
	'who',
	'he',
	'she',
	'they',
	'we',
	'i',
	'you'
]);
const ENGLISH_HAVE_QUANTIFIERS = new Set([
	'not',
	'several',
	'many',
	'multiple',
	'no',
	'two',
	'three',
	'four',
	'five',
	'a',
	'an',
	'the'
]);
const ENGLISH_DO_PREPOSITIONS = new Set([
	'in',
	'for',
	'to',
	'with',
	'on',
	'at',
	'by',
	'from',
	'under',
	'within'
]);
const ENGLISH_TO_KEEP_NEXT = new Set(['each', 'every', 'do', 'be']);
const ENGLISH_REPORTING_VERBS = new Set([
	'say',
	'says',
	'said',
	'state',
	'states',
	'stated',
	'mention',
	'mentions',
	'mentioned',
	'think',
	'thought',
	'believe',
	'believes',
	'ensure',
	'ensures',
	'show',
	'shows',
	'suggest',
	'suggests',
	'mean',
	'means',
	'meant',
	'notice',
	'noticed',
	'see',
	'saw',
	'know',
	'knew',
	'explain',
	'explains',
	'describe',
	'describes',
	'indicate',
	'indicates',
	'imply',
	'implies',
	'assume',
	'assumes',
	'hope',
	'hopes',
	'fear',
	'fears',
	'doubt',
	'doubts',
	'realize',
	'realized',
	'find',
	'found',
	'discover',
	'discovered'
]);

// "to" after an adjective complement: accessible, obvious, useful, important.
const ENGLISH_ADJECTIVE_TO_TAIL_RE = /(?:ble|ous|ive|ful|ent|ant)$/u;

function keepEnglishTo(tokens: EnglishToken[], at: number): boolean {
	const previous = tokens[at - 1]?.lower;
	if (
		previous &&
		(ENGLISH_CATENATIVE_VERBS.has(previous) ||
			ENGLISH_WH_WORDS.has(previous) ||
			ENGLISH_ADJECTIVE_TO_TAIL_RE.test(previous))
	) {
		return true;
	}

	const next = tokens[at + 1];
	if (!next) {
		return true;
	}
	return (
		ENGLISH_TO_KEEP_NEXT.has(next.lower) ||
		/^\$?\d/u.test(next.lower) ||
		/^[\\\-+±$]/u.test(next.lower)
	);
}

function keepEnglishHave(tokens: EnglishToken[], at: number): boolean {
	const next = tokens[at + 1];
	return !!next && (ENGLISH_HAVE_QUANTIFIERS.has(next.lower) || /^\d/u.test(next.lower));
}

function keepEnglishDo(tokens: EnglishToken[], at: number): boolean {
	if (tokens[at - 1]?.lower === 'to') {
		return true;
	}
	const next = tokens[at + 1];
	return !!next && (next.lower === 'not' || ENGLISH_DO_PREPOSITIONS.has(next.lower));
}

function keepEnglishIt(tokens: EnglishToken[], at: number): boolean {
	const previous = tokens[at - 1]?.lower;
	if (previous && ENGLISH_SUBORDINATORS.has(previous)) {
		return true;
	}
	const next = tokens[at + 1]?.lower;
	return !!next && ENGLISH_AUXILIARIES.has(next);
}

function keepEnglishBe(tokens: EnglishToken[], at: number): boolean {
	return ENGLISH_BE_SUBJECTS.has(tokens[at - 1]?.lower ?? '');
}

function isEnglishFunctionWord(tokens: EnglishToken[], at: number): boolean {
	const lower = tokens[at].lower;
	if (ENGLISH_CONTRACTION_ALIASES.has(lower)) {
		return isEnglishFunctionContraction(lower);
	}

	const entry = ENGLISH_FUNCTION_WORD_INDEX.get(lower);
	if (!entry) {
		return false;
	}

	switch (entry.kind) {
		case 'always':
			return true;
		case 'it':
			return !keepEnglishIt(tokens, at);
		case 'to':
			return !keepEnglishTo(tokens, at);
		case 'have':
			return !keepEnglishHave(tokens, at);
		case 'do':
			return !keepEnglishDo(tokens, at);
		case 'that':
			// A complementizer after a reporting verb is glue; the relative
			// connector after a noun ("the option that best completes") is not.
			return ENGLISH_REPORTING_VERBS.has(tokens[at - 1]?.lower ?? '');
		case 'be':
			return !keepEnglishBe(tokens, at);
		case 'article-a':
		case 'be-base':
			return false;
	}
}

// The span of whole words a phrase entry matches at `at`, or 0. Words must be
// separated by whitespace only, so "have, to be" is not a phrase.
function matchEnglishFunctionPhrase(text: string, tokens: EnglishToken[], at: number): number {
	const entries = ENGLISH_FUNCTION_PHRASE_INDEX.get(tokens[at].lower);
	if (!entries) {
		return 0;
	}

	for (const entry of entries) {
		if (at + entry.length > tokens.length) {
			continue;
		}
		let matched = true;
		for (let i = 0; i < entry.length; i++) {
			if (tokens[at + i].lower !== entry[i]) {
				matched = false;
				break;
			}
			if (i > 0 && !isWhitespaceGap(text, tokens[at + i - 1], tokens[at + i])) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return entry.length;
		}
	}
	return 0;
}

/** Marks the function words of `prose`; phrase runs are marked as one span. */
function englishFunctionWordMask(text: string, tokens: EnglishToken[]): boolean[] {
	const removed = new Array<boolean>(tokens.length).fill(false);

	for (let i = 0; i < tokens.length; i++) {
		const span = matchEnglishFunctionPhrase(text, tokens, i);
		if (!span) {
			continue;
		}
		for (let j = 0; j < span; j++) {
			removed[i + j] = true;
		}
		i += span - 1;
	}

	for (let i = 0; i < tokens.length; i++) {
		if (!removed[i] && isEnglishFunctionWord(tokens, i)) {
			removed[i] = true;
		}
	}

	return removed;
}

/** Deletes the function words of a prose span, word by word. */
function stripEnglishFunctionWordsFromProse(source: string): string {
	const tokens = englishTokens(source);
	const removed = englishFunctionWordMask(source, tokens);

	let out = '';
	let cursor = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (!removed[i]) {
			continue;
		}
		out += source.slice(cursor, tokens[i].start);
		cursor = tokens[i].end;
	}
	out += source.slice(cursor);

	return (
		out
			.replace(/\s+([,;:.!?])/gu, '$1')
			// A dropped article can leave the gap it filled: "(a type of…" ->
			// "(type of…".
			.replace(/\(\s+/gu, '(')
			.replace(/\s+\)/gu, ')')
			.replace(/\s+/gu, ' ')
	);
}

function stripEnglishFunctionWords(title: string): string {
	const stripped = mapOutsideMath(title, stripEnglishFunctionWordsFromProse)
		.replace(/\s+/gu, ' ')
		.trim();

	return Array.from(stripped).length >= TITLE_MIN_CHARS ? stripped : title;
}

/** Drops in `title`'s prose, used to decide whether a verbatim repair exists. */
function countDroppableEnglishWords(title: string): number {
	let count = 0;
	mapOutsideMath(title, (prose) => {
		const tokens = englishTokens(prose);
		const removed = englishFunctionWordMask(prose, tokens);
		count += removed.filter(Boolean).length;
		return prose;
	});
	return count;
}

// Clause punctuation left between kept words is noise: "biases, creating
// requirements" -> "biases creating requirements". Punctuation inside a number
// or math stays; dashes that separate clauses become spaces, hyphen inside a
// word is untouched.
function stripTitlePunctuation(title: string): string {
	return mapOutsideMath(title, (prose) =>
		prose
			.replace(/[,.;:!?，、；：！？。．]/gu, (match, offset: number, whole: string) => {
				const prev = whole[offset - 1] ?? '';
				const next = whole[offset + 1] ?? '';
				if (/[,.:，．：]/.test(match) && /\d/.test(prev) && /\d/.test(next)) {
					return match;
				}
				// An abbreviation dot is part of the word ("Dr.", "vs.", "e.g.").
				if (match === '.' && isAbbreviationDot(whole, offset)) {
					return match;
				}
				return ' ';
			})
			.replace(/[—–]/gu, ' ')
			.replace(/\s-+\s/gu, (match, offset: number, whole: string) => {
				const before = /(\S+)\s*$/u.exec(whole.slice(0, offset))?.[1] ?? '';
				const after = /^\s*(\S+)/u.exec(whole.slice(offset + match.length))?.[1] ?? '';
				// "x - y = 4", "(t - 2√2)": a dash between short math terms
				// is a subtraction, not clause punctuation.
				if (isSubtractionDash(before, after)) {
					return match;
				}
				return ' ';
			})
	)
		.replace(/\s+/gu, ' ')
		.trim();
}

// The longest prefix of `title` whose display width fits the cap.
function titleWidthWindow(title: string, limit: number): string {
	let window = '';
	let width = 0;
	for (const char of title) {
		const nextWidth = width + charWidth(char);
		if (nextWidth > limit) {
			break;
		}
		window += char;
		width = nextWidth;
	}
	return window;
}

// The last clause separator inside the window, or -1.
function lastTitleBreak(window: string): number {
	for (let i = window.length - 1; i >= 0; i--) {
		if (TITLE_BREAK_RE.test(window[i])) {
			return i;
		}
	}
	return -1;
}

// A window that runs into a relative clause reads better ending on the noun
// phrase: the clause is dropped whole where it starts, so the clipped title is
// still a complete phrase and needs no ellipsis. Only a single plain clause can
// end there; a prefix that already carries sentence punctuation must not leave
// its tail dangling.
function relativeClausePrefix(window: string): string | null {
	let relativeAt = -1;
	for (const match of window.matchAll(/[\s,]+(?:that|which|who)\s/giu)) {
		if (match.index !== undefined && window.length - (match.index + match[0].length) >= 20) {
			relativeAt = match.index;
		}
	}
	if (relativeAt < 0) {
		return null;
	}
	const prefix = window.slice(0, relativeAt).trim();
	if (
		prefix.split(/\s+/).length >= 3 &&
		displayWidth(prefix) >= 16 &&
		!/[.!?;:。！？；：]/u.test(prefix)
	) {
		return prefix;
	}
	return null;
}

// The trailing glue of a width cut: separators and a dangling connector
// ("…individual words while") are dropped like the dangling endings of a
// Chinese title.
function trimTitleCut(window: string): string {
	return window
		.replace(TITLE_TRAILING_SEPARATORS_RE, '')
		.replace(
			/[\s,]+(?:and|or|but|while|when|if|that|which|because|so|then|than|to|of|in|on|at|for|with|from|by|as)\s*$/iu,
			''
		);
}

// Fits a title to the display-width cap, breaking at the last word space or
// clause separator so the cut never lands inside a word.
function fitTitleWidth(title: string): string {
	if (displayWidth(title) <= REASONING_SUMMARY_TITLE_MAX_WIDTH) {
		return title;
	}

	const window = titleWidthWindow(title, REASONING_SUMMARY_TITLE_MAX_WIDTH);
	const relative = relativeClausePrefix(window);
	if (relative) {
		return relative;
	}

	const breakAt = lastTitleBreak(window);
	let cutWindow = window;
	if (breakAt + 1 >= window.length / 2) {
		cutWindow = window.slice(0, breakAt + 1);
	} else {
		// No usable separator: back up to the last whole word. The words come from
		// the full title, where the cut has not split the last word yet.
		const lastWord = wordSegments(title)
			.filter((part) => part.end <= window.length)
			.at(-1);
		if (lastWord && lastWord.end >= window.length / 2) {
			cutWindow = window.slice(0, lastWord.end);
		}
	}

	const cut = trimTitleCut(cutWindow);
	return cut ? `${cut}…` : title;
}

// A polished label may still end on the words that introduced its list; the body
// keeps them with the list, so the title drops them.
const TITLE_DANGLING_LABEL_TAIL_RE =
	/[\s,]+(?:that|which|who)\s+(?:covers?|includes?|involves?|contains?|describes?|explains?|provides?|offers?|addresses?|discusses?|lists?|details?|follows?|comes?|applies?)$|[\s,]+(?:and|or|but|while|when|if|that|which|who|of|for|with|to|in|on|at|by|from|as|about|into|over|under|through|via|per|because|so|then|than)$/iu;

function stripDanglingLabelTail(title: string): string {
	let text = title;

	for (;;) {
		const next = text.replace(TITLE_DANGLING_LABEL_TAIL_RE, '');
		if (next === text || !next) {
			return next || title;
		}
		text = next;
	}
}

// Turns `[sourceStart, sourceEnd)` into a title, consuming through `consumedEnd`
// (which may cover a bold label's markers too). The width cap applies to the
// cleaned title while the source is consumed whole, so no marker leaks into the
// body. `polish` is right for a prose label, wrong for a heading.
function carveTitle(
	text: string,
	sourceStart: number,
	sourceEnd: number,
	consumedEnd: number,
	polish = false
): TitleCandidate {
	const rawSource = text.slice(sourceStart, sourceEnd);
	if (!rawSource.trim()) {
		return NO_TITLE;
	}

	const cleaned = cleanTitleSource(cutTitleAtPunctuation(rawSource).title);
	if (!cleaned.title) {
		return NO_TITLE;
	}

	const polished = polish
		? stripDanglingLabelTail(stripTitlePunctuation(stripEnglishFunctionWords(cleaned.title)))
		: cleaned.title;
	const fitted = dropUnclosedBrackets(fitTitleWidth(stripMathDelimiters(polished)));

	return {
		...cleaned,
		title: normalizeTitleSpacing(fitted),
		consumed: consumedEnd,
		// The width cut keeps only a prefix, so the source is consumed whole and
		// the body must keep it.
		abridged: cleaned.abridged || fitted !== cleaned.title
	};
}

// Words that name the shape of a request or a beat instead of a topic. One list
// feeds the weak-label test, the weak-primary test and the sentence-skip pattern.
const GENERIC_ENGLISH_WORDS: ReadonlyArray<string> = [
	// Function words and light verbs.
	'for',
	'to',
	'about',
	'of',
	'on',
	'in',
	'at',
	'by',
	'from',
	'with',
	'without',
	'the',
	'a',
	'an',
	'and',
	'or',
	'but',
	'not',
	'that',
	'this',
	'it',
	'its',
	'is',
	'are',
	'was',
	'were',
	'has',
	'have',
	'had',
	'do',
	'does',
	'did',
	'be',
	'been',
	'being',
	// The asker and the request.
	'user',
	'person',
	'question',
	'problem',
	'task',
	'prompt',
	'request',
	'message',
	'ask',
	'asks',
	'asked',
	'asking',
	'require',
	'requires',
	'required',
	'requiring',
	'want',
	'wants',
	'wanted',
	'wanting',
	'need',
	'needs',
	'needed',
	'needing',
	'expect',
	'expects',
	'expected',
	'explain',
	'identify',
	// The shape of an answer.
	'condition',
	'result',
	'answer',
	'solution',
	'reason',
	'issue',
	'point',
	'step',
	'method',
	'approach',
	'idea',
	'note',
	'summary',
	'case',
	'example',
	'picture',
	'thought',
	'basis',
	'setup',
	'equation',
	'simple',
	'following',
	'below',
	// Reasoning beats and sentence openers.
	'wait',
	'hold',
	'hmm',
	'hm',
	'oh',
	'ah',
	'okay',
	'ok',
	'alright',
	'well',
	'right',
	'yes',
	'no',
	'great',
	'nice',
	'good',
	'perfect',
	'interesting',
	'indeed',
	'just',
	'really',
	'maybe',
	'perhaps',
	'actually',
	'alternatively',
	'instead',
	'unless',
	'again',
	'still',
	'also',
	'if',
	'then',
	'lets',
	'let me',
	'let us',
	'search',
	'run',
	'stop',
	'double',
	// Question words.
	'what',
	'which',
	'who',
	'whom',
	'whose',
	'when',
	'where',
	'why',
	'how'
];

const GENERIC_ENGLISH_WORD_SET = new Set(GENERIC_ENGLISH_WORDS);

// Sentence openers skipped while looking for the block's topic sentence; the
// words come from the list above, only the sentence-start structure is here.
const TOPIC_SENTENCE_SKIP_RE = new RegExp(
	`^(?:${GENERIC_ENGLISH_WORDS.map((word) => {
		const pattern = word.replace(/\s+/gu, '\\s+');
		// Repeated interjections ("hmmm", "hmm") are one beat.
		return word === 'hmm' || word === 'hm' ? `${pattern}+` : pattern;
	}).join('|')})\\b`,
	'iu'
);

// A title that is nothing but an opener names no topic: the block can title from
// a later sentence instead. A repeated beat counts too.
function isDiscourseMarkerOnly(text: string): boolean {
	let current = text
		.replace(/^[\s,，、.。!！?？;；:：~～]+/u, '')
		.replace(/[\s,，、.。!！?？;；:：~～]+$/u, '');
	let stripped = false;

	for (;;) {
		const match = matchTitleLeadMarker(current);
		if (!match) {
			break;
		}
		stripped = true;
		current = current.slice(match.length).replace(TITLE_LEAD_MARKER_PUNCT_RE, '').trimStart();
	}

	return stripped && current === '';
}

// A title names something only with at least two content words: framing words,
// English function words and CJK glue do not count, and an opener carries
// nothing. CJK content counts by word (缓存失效 is two), English on the token
// layer, where a possessive or hyphen compound is one content word.
function titleContentWordTerms(title: string): string[] {
	if (isDiscourseMarkerOnly(title)) {
		return [];
	}

	const terms: string[] = [];

	if (!CJK_RUN_RE.test(title)) {
		const tokens = englishTokens(title);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!/^[A-Za-z]{2,}/u.test(token.text)) {
				continue;
			}
			if (GENERIC_ENGLISH_WORD_SET.has(token.lower)) {
				continue;
			}
			if (isEnglishFunctionWord(tokens, i)) {
				continue;
			}
			terms.push(token.lower);
		}
		return terms;
	}

	for (const part of wordSegments(title)) {
		if (CJK_RUN_RE.test(part.word)) {
			if (Array.from(part.word).some((char) => !CJK_GLUE_CHARS.has(char))) {
				terms.push(part.word);
			}
			continue;
		}
		if (!/^[A-Za-z]{2,}/u.test(part.word)) {
			continue;
		}
		if (GENERIC_ENGLISH_WORD_SET.has(part.word.toLowerCase())) {
			continue;
		}
		if (isDroppableEnglishUnit(part.word)) {
			continue;
		}
		terms.push(part.word.toLowerCase());
	}
	return terms;
}

function titleContentWordCount(title: string): number {
	return titleContentWordTerms(title).length;
}

// A label made only of framing words labels nothing: the block renders titleless.
function isWeakLabelTitle(title: string): boolean {
	return titleContentWordCount(title.trim()) < 2;
}

function isUsableLabelTitle(title: string): boolean {
	return (
		Array.from(title).length >= TITLE_MIN_CHARS && isTopicTitle(title) && !isWeakLabelTitle(title)
	);
}

const CJK_RUN_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;

export type SentenceSpan = { start: number; end: number; text: string };

const SENTENCE_END_CHARS = '。！？!?…；;';
const SENTENCE_CLOSE_CHARS = '”"’\'）」』）';

// A terminator inside brackets belongs to the bracketed expression, not to the
// sentence: the `?` in `(1/u-1/v?)` is a stray mark inside a formula, and cutting
// there leaves the closer to open the next span as an orphan. One depth counter
// covers every pair, so `[x?]` and `(a (b? c) d)` nest without a stack; an
// unmatched opener is forgotten at the newline, exactly like an open quote.
// Full-width pairs are the CJK formulas' own brackets: `）` is also in the
// terminator's closing-run set below, but there it only trails a terminator and
// never acts as one; the other pairs appear in no terminator set, so the depth
// bookkeeping lives only here.
const SENTENCE_BRACKET_OPEN_CHARS = '([{（【｛';
const SENTENCE_BRACKET_CLOSE_CHARS = ')]}）】｝';

// "vs.", "e.g.", "Dr." — an abbreviation dot never ends a sentence or a title.
// One helper for both passes, so they agree on where it ends.
const ABBREVIATION_DOT_RE =
	/(?:^|\s)(?:vs|etc|dr|mr|mrs|ms|st|no|fig|eq|ref|approx|al|inc|ltd|corp|e\.g|i\.e|cf)\.$/iu;

function isAbbreviationDot(text: string, i: number): boolean {
	return ABBREVIATION_DOT_RE.test(text.slice(0, i + 1));
}

// Sentences are the IDF documents; a Chinese comma also closes a clause, so
// later clauses are considered on their own.
/**
 * An unclosed quote suspends every terminator until its closer ("We can include
 * "反过来，……取到。" to be rigorous." is one sentence), so quoted punctuation is
 * its own. Straight quotes toggle; the apostrophe never opens prose.
 */
const SENTENCE_SPLIT_QUOTE_CLOSES: ReadonlyMap<string, string> = new Map([
	['“', '”'],
	['「', '」'],
	['『', '』'],
	['"', '"']
]);

// Loads one span, trimmed, so every offset still points into `text`.
function pushSentenceSpan(
	sentences: SentenceSpan[],
	text: string,
	start: number,
	end: number
): void {
	const raw = text.slice(start, end);
	const lead = raw.length - raw.trimStart().length;
	const trimmed = raw.trim();
	if (trimmed) {
		sentences.push({ start: start + lead, end: start + lead + trimmed.length, text: trimmed });
	}
}

// The end of a sentence that starts at `i`, or null when the character is no
// terminator. A run of closing marks belongs to the sentence ("好了。”"), and a
// dot ends one only at a word end — not after a digit, not an abbreviation.
function endsSentenceAt(text: string, i: number, endChars: string): number | null {
	const char = text[i];
	if (endChars.includes(char)) {
		let end = i + 1;
		while (end < text.length && SENTENCE_CLOSE_CHARS.includes(text[end])) {
			end++;
		}
		return end;
	}
	if (char !== '.') {
		return null;
	}
	const prev = text[i - 1] ?? '';
	const next = text[i + 1] ?? '';
	if (/\d/.test(prev) || isAbbreviationDot(text, i) || (next !== '' && !/\s/.test(next))) {
		return null;
	}
	return i + 1;
}

// A terminator sitting right behind the closer ("…体系？" the connectives ask)
// makes the quoted unit the sentence's end: break after the closer. A quote
// closed mid-clause (…取到" to be rigorous.) has none, so the sentence keeps
// running and the tail stays with its sentence.
function quoteClosesSentence(text: string, i: number, endChars: string): boolean {
	const prev = text[i - 1] ?? '';
	return endChars.includes(prev) || prev === '.';
}

// The sentence scanner's moving state: the text being cut, the terminators it
// honors, the quote currently open, the bracket depth and the span being loaded.
type SentenceScan = {
	text: string;
	endChars: string;
	quoteClose: string | null;
	bracketDepth: number;
	start: number;
	sentences: SentenceSpan[];
};

function closeSentenceAt(scan: SentenceScan, end: number): void {
	pushSentenceSpan(scan.sentences, scan.text, scan.start, end);
	scan.start = end;
}

// One unit of the scan — the quote state machine, the bracket depth and the push
// decision — and the index the loop continues from.
//
// Order of judgment: an open quote owns the scan, so brackets inside it are just
// text ("(x" opens a quote with a bracket in it); a quote opened inside brackets
// still owns the scan until it closes, but its closer never ends the sentence
// while the depth is positive ("…(see "a?" here)…"). A newline ends the sentence
// and abandons both the quote and the depth, so a stray opener cannot poison the
// lines after it. Outside a quote, a bracket opener raises the depth, a closer
// lowers it (never below zero, so an orphan closer stays ordinary text), and a
// positive depth suppresses every terminator: bracketed punctuation is part of
// the formula or enumeration it sits in. At depth zero the ordinary end-of-
// sentence rules apply.
function scanSentenceAt(scan: SentenceScan, i: number): number {
	const char = scan.text[i];
	if (scan.quoteClose) {
		if (char === scan.quoteClose) {
			if (scan.bracketDepth === 0 && quoteClosesSentence(scan.text, i, scan.endChars)) {
				closeSentenceAt(scan, i + 1);
			}
			scan.quoteClose = null;
			return i;
		}
		if (char !== '\n') {
			return i;
		}
		scan.quoteClose = null;
		scan.bracketDepth = 0;
		closeSentenceAt(scan, i + 1);
		return i;
	}

	const quotePair = SENTENCE_SPLIT_QUOTE_CLOSES.get(char);
	if (quotePair) {
		scan.quoteClose = quotePair;
		return i;
	}
	if (char === '\n') {
		scan.bracketDepth = 0;
		closeSentenceAt(scan, i + 1);
		return i;
	}
	if (SENTENCE_BRACKET_OPEN_CHARS.includes(char)) {
		scan.bracketDepth++;
		return i;
	}
	if (SENTENCE_BRACKET_CLOSE_CHARS.includes(char)) {
		if (scan.bracketDepth > 0) {
			scan.bracketDepth--;
		}
		return i;
	}
	if (scan.bracketDepth > 0) {
		return i;
	}
	const end = endsSentenceAt(scan.text, i, scan.endChars);
	if (end === null) {
		return i;
	}
	closeSentenceAt(scan, end);
	return end - 1;
}

/**
 * Cuts `text` into sentence spans; offsets point into `text`. Exported because
 * this segmentation is the module's contract: terminator handling inside quotes
 * and brackets decides which phrases a title can be built from.
 */
export function splitSentences(text: string): SentenceSpan[] {
	const scan: SentenceScan = {
		text,
		endChars: CJK_RUN_RE.test(text) ? `${SENTENCE_END_CHARS}，` : SENTENCE_END_CHARS,
		quoteClose: null,
		bracketDepth: 0,
		start: 0,
		sentences: []
	};
	for (let i = 0; i < text.length; i++) {
		i = scanSentenceAt(scan, i);
	}
	closeSentenceAt(scan, text.length);
	return scan.sentences;
}

// Function words deleted from a Chinese lead: particles, pronouns, prepositions,
// conjunctions, modals, fillers and light verbs go; every content word stays, in
// order. Matching is by word segment, so the bare 的/了/在 entries cannot fire
// inside 目的, 了解 or 存在. A few entries segment into several tokens
// ("实际上", "换言之") and match their tokens in sequence.
const CHINESE_FUNCTION_WORDS: ReadonlyArray<string> = [
	// Particles and pronouns.
	'的',
	'地',
	'得',
	'了',
	'着',
	'过',
	'我',
	'你',
	'他',
	'她',
	'它',
	'们',
	'这',
	'那',
	'挺',
	'好',
	'请',
	'请求',
	'真',
	'会',
	'能',
	'要',
	'想',
	'是',
	'在',
	'把',
	'被',
	'让',
	'给',
	'向',
	'往',
	'从',
	'对',
	'和',
	'与',
	'及',
	'或',
	'也',
	'都',
	'就',
	'还',
	'又',
	'再',
	'很',
	'太',
	'才',
	'只',
	'则',
	'而',
	'但',
	'却',
	'并',
	'由',
	'跟',
	'按',
	'为',
	'此',
	'该',
	'等',
	'若',
	'将',
	'别',
	'其',
	// Sentence-final particles and interjections.
	'吗',
	'呢',
	'吧',
	'啊',
	'呀',
	'啦',
	'嘛',
	'呗',
	'嗯',
	'哦',
	'呃',
	'唉',
	'诶',
	'喂',
	'喔',
	'唔',
	// Pronouns and demonstratives.
	'我们',
	'你们',
	'他们',
	'她们',
	'它们',
	'咱们',
	'大家',
	'自己',
	'别人',
	'这个',
	'那个',
	'这些',
	'那些',
	'这里',
	'那里',
	'这儿',
	'那儿',
	'这样',
	'那样',
	'这么',
	'那么',
	'这种',
	'那种',
	'这时',
	'那时',
	'这时候',
	'那时候',
	'此时',
	// Quantifiers.
	'一个',
	'一些',
	'一下',
	'一下子',
	'一样',
	'一起',
	'一直',
	'一点',
	'有点',
	'有些',
	'有的',
	'某些',
	'某个',
	'别的',
	'任何',
	'每个',
	'每天',
	'每次',
	'每当',
	'每种',
	'各种',
	'各个',
	'整个',
	'所有',
	'一切',
	// The question frame of a lead names the shape of the ask, not the task.
	// 用户 itself is absent: the segmenter gives the same token in 用户数据 and
	// 新用户, and the asker frame (which knows the structure) lifts the subject.
	'用户问',
	'是什么',
	'什么是',
	// Conjunctions and connectives.
	'而且',
	'并且',
	'或者',
	'或者说',
	'或是',
	'还是',
	'但是',
	'可是',
	'不过',
	'然而',
	'因为',
	'所以',
	'因此',
	'因而',
	'由于',
	'于是',
	'如果',
	'如果说',
	'假如',
	'即使',
	'虽然',
	'尽管',
	'既然',
	'无论',
	'不管',
	'不论',
	'只要',
	'只有',
	'除非',
	'除了',
	'为了',
	'以便',
	'从而',
	'进而',
	'反而',
	'同时',
	'另外',
	'此外',
	'接着',
	'然后',
	'首先',
	'其次',
	'最后',
	'总之',
	'综上',
	'例如',
	'比如',
	'譬如',
	'诸如',
	'等等',
	'之类',
	'以及',
	'甚至',
	'要么',
	'要是',
	'就是',
	'只是',
	'总是',
	'对吧',
	'对不对',
	'而是',
	'算是',
	'便是',
	'老是',
	'一旦',
	'万一',
	'哪怕',
	'就算',
	// Prepositions and light verbs.
	'按照',
	'依照',
	'根据',
	'针对',
	'随着',
	'沿着',
	'对于',
	'关于',
	'至于',
	'用于',
	'终于',
	'作为',
	'处于',
	'加以',
	'予以',
	'进行',
	'看起来',
	'起来',
	'即可',
	// Adverbs and time words.
	'正在',
	'已经',
	'即将',
	'将要',
	'马上',
	'立刻',
	'立即',
	'仍然',
	'依然',
	'始终',
	'尽快',
	'尽量',
	'尽可能',
	'逐渐',
	'渐渐',
	'随后',
	'接下来',
	'后来',
	'现在',
	'目前',
	'当前',
	'当时',
	'有时',
	'有时候',
	'时候',
	'的话',
	// Modals and mental verbs.
	'可以',
	'可能',
	'应该',
	'应当',
	'必须',
	'需要',
	'能够',
	'想要',
	'打算',
	'准备',
	'希望',
	'觉得',
	'认为',
	'知道',
	'看看',
	'试试',
	'想想',
	'想一想',
	'假设',
	// Hedges, degree and discourse.
	'好像',
	'几乎',
	'大概',
	'大约',
	'也许',
	'或许',
	'似乎',
	'差不多',
	'基本上',
	'实际上',
	'事实上',
	'其实',
	'确实',
	'的确',
	'当然',
	'显然',
	'反正',
	'毕竟',
	'究竟',
	'到底',
	'简直',
	'千万',
	'务必',
	'稍微',
	'非常',
	'特别',
	'仔细',
	'一般',
	'通常',
	'经常',
	'常常',
	'往往',
	'分别',
	'真的',
	'真正',
	'上述',
	'所述',
	'如下',
	'以下',
	'以上',
	'下面',
	'上面',
	'其中',
	'也就是说',
	'就是说',
	'换句话说',
	'换言之',
	'总的来说',
	'总结一下',
	'简单来说',
	'来说'
]
	// Leading openers are owned by TITLE_LEAD_MARKERS and lifted only at the
	// start; duplicates here would delete them from the middle of a phrase too.
	.filter((word) => !CHINESE_LEAD_MARKER_WORDS.has(word));

// Whole-segment lookup for the scorer: a title does not end on a word a reader
// would read as glue.
const CHINESE_FUNCTION_WORD_SET = new Set(CHINESE_FUNCTION_WORDS);

// A table entry prepared for segment matching: the entry's own word segments,
// so a compound the segmenter splits still matches as the sequence it is.
type ChineseFunctionPhrase = { word: string; tokens: string[] };

// Longest token sequence first, then longest word: "也就是说" over "就是",
// "总结一下" over "一下".
const CHINESE_FUNCTION_PHRASES: ReadonlyArray<ChineseFunctionPhrase> = CHINESE_FUNCTION_WORDS.map(
	(word) => ({ word, tokens: wordSegments(word).map((part) => part.word) })
).sort((a, b) => b.tokens.length - a.tokens.length || b.word.length - a.word.length);

// Buckets by first word segment: at a given word only one entry can match.
const CHINESE_FUNCTION_PHRASE_INDEX = new Map<string, ChineseFunctionPhrase[]>();
for (const phrase of CHINESE_FUNCTION_PHRASES) {
	const first = phrase.tokens[0];
	if (!first) {
		continue;
	}
	const bucket = CHINESE_FUNCTION_PHRASE_INDEX.get(first);
	if (bucket) {
		bucket.push(phrase);
	} else {
		CHINESE_FUNCTION_PHRASE_INDEX.set(first, [phrase]);
	}
}

// Measure words that are also function words: removing one alone would leave
// the numeral dangling ("两只" -> "两"). The numeral + measure stay together.
const CHINESE_MEASURE_WORDS = new Set(['只', '把', '对']);
const CHINESE_NUMERAL_RE = /[一二两三四五六七八九十百千万几半零〇]/u;

// Words whose neighbouring segment makes them content. The segmenter keeps 用户名
// and 新用户 together but splits 另外一个 and 第一个, where dropping 一个 would
// leave a stray 另/第. This is the only residual context, a whole-segment lookup.
const CHINESE_FUNCTION_WORD_KEEP_PREV = new Map<string, ReadonlySet<string>>([
	['一个', new Set(['另', '第', '几'])]
]);

type ChineseFunctionMatch = { word: string; end: number; count: number };

// Matches a function phrase at word index `at`. The words of the phrase must be
// adjacent word segments (whitespace between them is fine, punctuation is not).
function matchChineseFunctionPhrase(
	text: string,
	words: WordSegment[],
	at: number
): ChineseFunctionMatch | null {
	const entries = CHINESE_FUNCTION_PHRASE_INDEX.get(words[at].word);
	if (!entries) {
		return null;
	}

	for (const entry of entries) {
		if (at + entry.tokens.length > words.length) {
			continue;
		}

		let matched = true;
		for (let i = 0; i < entry.tokens.length; i++) {
			if (words[at + i].word !== entry.tokens[i]) {
				matched = false;
				break;
			}
			if (i > 0 && !isWhitespaceGap(text, words[at + i - 1], words[at + i])) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return {
				word: entry.word,
				end: words[at + entry.tokens.length - 1].end,
				count: entry.tokens.length
			};
		}
	}
	return null;
}

// A measure word after a numeral stays with it; only the simple "一" form is
// dropped whole ("一只" -> nothing). `null` means an ordinary function word.
function measureWordHandling(
	source: string,
	token: WordSegment,
	match: ChineseFunctionMatch
): 'trim-one' | 'keep' | null {
	if (!CHINESE_MEASURE_WORDS.has(match.word)) {
		return null;
	}
	const prevChar = source[token.start - 1] ?? '';
	if (!CHINESE_NUMERAL_RE.test(prevChar)) {
		return null;
	}
	const beforeNumeral = source[token.start - 2] ?? '';
	const after = source[match.end] ?? '';
	if (
		prevChar === '一' &&
		!CHINESE_NUMERAL_RE.test(beforeNumeral) &&
		beforeNumeral !== '第' &&
		!CHINESE_NUMERAL_RE.test(after)
	) {
		return 'trim-one';
	}
	return 'keep';
}

// Words whose neighbouring segment makes them content: 另外一个 / 第一个 keep 一个.
function chineseFunctionKeptBefore(
	words: readonly WordSegment[],
	index: number,
	match: ChineseFunctionMatch
): boolean {
	const keepBefore = CHINESE_FUNCTION_WORD_KEEP_PREV.get(match.word);
	return Boolean(keepBefore && index > 0 && keepBefore.has(words[index - 1].word));
}

// Deletes function words by walking word segments, so a particle is only matched
// as a word of its own. A word between Latin or digit runs leaves a space, so the
// runs never glue ("Python的pygame库" -> "Python pygame 库"). Math is verbatim.
function stripChineseFunctionWords(source: string): string {
	const mathRanges = [...source.matchAll(MATH_SPAN_RE)].map((match) => ({
		start: match.index ?? 0,
		end: (match.index ?? 0) + match[0].length
	}));
	const words = wordSegments(source);

	let out = '';
	let cursor = 0;
	let index = 0;

	while (index < words.length) {
		const token = words[index];
		if (token.start > cursor) {
			out += source.slice(cursor, token.start);
		}

		const match = matchChineseFunctionPhrase(source, words, index);
		const overlapsMath =
			match !== null &&
			mathRanges.some((range) => token.start < range.end && match.end > range.start);

		if (!match || overlapsMath) {
			out += source.slice(token.start, token.end);
			cursor = token.end;
			index++;
			continue;
		}

		const measure = measureWordHandling(source, token, match);
		if (measure === 'keep' || chineseFunctionKeptBefore(words, index, match)) {
			out += source.slice(token.start, match.end);
		} else if (measure === null) {
			// The word is dropped; a word between Latin or digit runs leaves a
			// space, so the runs never glue.
			const next = source[match.end] ?? '';
			if (/[A-Za-z0-9]/.test(out[out.length - 1] ?? '') && /[A-Za-z0-9]/.test(next)) {
				out += ' ';
			}
		} else if (out.endsWith('一')) {
			out = out.slice(0, -1);
		}
		cursor = match.end;
		index += match.count;
	}

	return out + source.slice(cursor);
}

// A Chinese lead names its task in the opening clause and then qualifies it. The
// title is extracted by clause, not truncated; the cap is the backstop for one
// long clause.
const CHINESE_LEAD_TARGET_WIDTH = 40;

// Clause punctuation that can end an extracted title.
const CHINESE_CLAUSE_BREAK_RE = /[，、；：]/u;

// A first clause thinner than this is a lead-in ("服用奥美拉唑后，…"), not a
// topic: the extraction keeps the following clause too when the hard cap allows.
const CHINESE_LEAD_MIN_WIDTH = 24;

function shortenChineseLead(text: string): string {
	const lead = text.replace(/^[\s，、；：]+/u, '').replace(/[\s。]+$/u, '');
	if (displayWidth(lead) <= CHINESE_LEAD_TARGET_WIDTH) {
		return lead;
	}

	let width = 0;
	// Cut positions sit on a segment boundary: a clause break is taken before its
	// punctuation, and a cut never lands inside a word.
	let lastBreak = -1;
	let breakEnd = -1;
	let stopped = false;

	for (const part of segmentWords(lead)) {
		const next = width + displayWidth(part.word);
		if (next > CHINESE_LEAD_TARGET_WIDTH) {
			stopped = true;
			break;
		}
		width = next;
		if (CHINESE_CLAUSE_BREAK_RE.test(part.word)) {
			lastBreak = part.start;
			breakEnd = part.end;
		}
	}
	if (!stopped) {
		return lead;
	}
	if (lastBreak > 0) {
		const kept = lead.slice(0, lastBreak);
		// A time or condition clause is a lead-in, not a topic: keep the next
		// clause too when the hard cap allows. Any other short first clause is the topic.
		const dependent = /(?:后|时|前|之后|之前|以后|以前|的时候)$/u.test(kept);
		if (!dependent || displayWidth(kept) >= CHINESE_LEAD_MIN_WIDTH) {
			return kept;
		}
		const nextBreak = lead.slice(breakEnd).search(CHINESE_CLAUSE_BREAK_RE);
		const extended = nextBreak === -1 ? lead : lead.slice(0, breakEnd + nextBreak);
		return displayWidth(extended) <= REASONING_SUMMARY_TITLE_MAX_WIDTH ? extended : kept;
	}

	// The first clause alone runs past the target: the clause is the unit, and the
	// hard width cap still applies. Returning it keeps its head noun.
	return lead;
}

// A Chinese lead title: take the opening clauses as written first; only a phrase
// still past the width cap is compressed by deleting function words.
function finalizeChineseLead(source: string): string {
	const phrase = shortenChineseLead(source);
	if (displayWidth(phrase) <= CHINESE_LEAD_TARGET_WIDTH) {
		// A clause cut can leave the phrase on a connector ("…需求包括",
		// "输出格式的话"); those endings are dropped like the dangling endings of
		// the character-cut path.
		return finalizeTitle(stripDanglingTitleEnding(phrase), false);
	}
	return finalizeTitle(shortenChineseLead(stripChineseFunctionWords(source)));
}

// Characters that are pure glue wherever they appear: the coverage check may drop
// CJK units from this set without changing what a line says.
const CJK_GLUE_CHARS = new Set(
	'的了着是个什么吗呢吧啊嗯哦呀啦哪谁怎之其此这那把被让给从向而但并就也都还又再更很太等与和及或于各每某才却则将要来在中者进一没几'
		.split('')
		.concat(['呗', '唉'])
);

// Code punctuation in a lead: a snake_case identifier or a code semicolon marks
// code with a comment, not prose, and the plain lead cut reads better. Math
// notation does not count: it compresses like prose.
const CODE_MARK_RE = /[`;]|[A-Za-z0-9]_[A-Za-z0-9]/gu;

// The block's opening sentence taken as a phrase, or null when the lead is not a
// Chinese sentence: a code lead keeps the plain cut, since deleting function
// words there would put code on the title line.
function deriveCompressedLeadTitle(
	text: string,
	from = 0,
	allowTail = false,
	limit = text.length
): ProseCandidate | null {
	const slice = text.slice(from, limit);
	const period = slice.indexOf('。');
	if (period === -1) {
		return null;
	}

	// A comma before the full stop is a sentence boundary: the compressed lead
	// is the clause before it, not the whole sentence.
	const comma = slice.indexOf('，');
	const end = comma !== -1 && comma < period ? comma : period;
	const source = text.slice(from, from + end + (end === period ? 1 : 0));
	const lead = source.replace(/^[\s"'“”「『（(>*-]+/u, '');
	if (!CJK_RUN_RE.test(lead[0] ?? '') || (source.match(CODE_MARK_RE)?.length ?? 0) >= 2) {
		return null;
	}

	// The openers and asker frame are lifted before the phrase is cut, so
	// "用户想让我用 Rust 实现…" titles with "用 Rust 实现…".
	const title = finalizeChineseLead(cleanTitleSource(source).title);
	if (Array.from(title).length < TITLE_MIN_CHARS) {
		return null;
	}

	const consumed = from + end + 1;
	if (!allowTail && !text.slice(consumed).trim()) {
		return null;
	}

	// The title is a phrase from the sentence, not the sentence itself: the body
	// keeps the original so it still reads in full.
	return { title, consumed, abridged: true, compressed: false };
}

// A phrase-title keeps the lead's own words: 8 tokens is the width a natural
// phrase reaches before it has to step back.
const ENGLISH_LEAD_PHRASE_TOKENS = 8;
const ENGLISH_LEAD_PHRASE_WIDTH = 32;

// A word end can sit before a closing math/code delimiter ("$b$", "`x`"): the
// delimiter belongs to the word, so the cut goes past it. An unpaired `$` left
// behind would survive into the title.
function snapLeadBreak(lead: string, end: number): number {
	let cut = end;
	while (cut < lead.length && (lead[cut] === '$' || lead[cut] === '`')) {
		cut++;
	}
	return cut;
}

// A formula tail ("… such that $13_b \cdot 15_b = 243_b$", "… where x²") is the
// condition, not the topic: the prose before the connector is the phrase.
function pushFormulaTailBreaks(lead: string, words: EnglishToken[], ends: number[]): void {
	for (let i = 1; i < words.length; i++) {
		const lower = words[i].lower;
		const next = words[i + 1]?.lower;
		if (
			(lower === 'such' && next === 'that') ||
			lower === 'where' ||
			(lower === 'given' && next === 'that')
		) {
			const tail = lead.slice(words[i].start);
			if (/[$\\=^_]|[≤≥≠≈±×÷√]/u.test(tail)) {
				ends.push(snapLeadBreak(lead, words[i - 1].end));
			}
		}
	}
}

// End offsets a cut may land on: the last whole word before a clause separator
// (a comma, semicolon, colon or spaced dash outside math and code), plus the
// prose before a formula tail ("… such that $13_b …").
function leadClauseBreakEnds(lead: string, words: EnglishToken[]): number[] {
	let wordIndex = 0;
	let lastWordEnd = 0;
	const breaks: number[] = [];
	pushFormulaTailBreaks(lead, words, breaks);
	let inMath = false;
	let inCode = false;

	for (let i = 0; i < lead.length; i++) {
		// `lastWordEnd` is the end of the last whole token starting before `i`:
		// where a clause cut is allowed to land.
		while (wordIndex < words.length && words[wordIndex].end <= i) {
			lastWordEnd = words[wordIndex].end;
			wordIndex++;
		}

		const char = lead[i];
		if (char === '`') {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			continue;
		}
		if (char === '$') {
			inMath = !inMath;
			continue;
		}
		if (inMath) {
			continue;
		}
		if (char === ',' || char === ';' || char === ':') {
			if (lastWordEnd > 0 && breaks[breaks.length - 1] !== lastWordEnd) {
				breaks.push(snapLeadBreak(lead, lastWordEnd));
			}
			continue;
		}
		if (
			(char === '-' || char === '–' || char === '—') &&
			/\s/u.test(lead[i - 1] ?? '') &&
			/\s/u.test(lead[i + 1] ?? '')
		) {
			const before = /(\S+)\s*$/u.exec(lead.slice(0, i))?.[1] ?? '';
			const after = /^\s*(\S+)/u.exec(lead.slice(i + 1))?.[1] ?? '';
			if (
				!isSubtractionDash(before, after) &&
				lastWordEnd > 0 &&
				breaks[breaks.length - 1] !== lastWordEnd
			) {
				breaks.push(snapLeadBreak(lead, lastWordEnd));
			}
		}
	}

	return breaks;
}

// The last clause cut that reads as a phrase and fits the title budget, or null.
function lastFittingLeadCut(lead: string, ends: readonly number[]): string | null {
	const cutEnds = [...new Set(ends)].sort((a, b) => a - b);
	for (let i = cutEnds.length - 1; i >= 0; i--) {
		const phrase = lead.slice(0, cutEnds[i]).trimEnd();
		if (
			Array.from(phrase).length >= TITLE_MIN_CHARS &&
			// The phrase must fit the title token target; a clause wider than that
			// is not a step back yet.
			countReasoningTokens(phrase) <= REASONING_SUMMARY_TITLE_TOKEN_TARGET &&
			displayWidth(phrase) <= ENGLISH_LEAD_PHRASE_WIDTH
		) {
			return phrase;
		}
	}
	return null;
}

// Cuts an over-wide English lead back to its last clause break that still fits.
// The cut lands on a word boundary (the end of the word before the separator),
// so a hyphen compound is never split. Deleting function words is the fallback.
function cutEnglishLeadPhrase(lead: string): { phrase: string; fits: boolean } {
	if (
		countReasoningTokens(lead) <= ENGLISH_LEAD_PHRASE_TOKENS &&
		displayWidth(lead) <= ENGLISH_LEAD_PHRASE_WIDTH
	) {
		return { phrase: lead, fits: true };
	}

	const phrase = lastFittingLeadCut(lead, leadClauseBreakEnds(lead, englishTokens(lead)));
	return phrase === null ? { phrase: lead, fits: false } : { phrase, fits: true };
}

// A prose title prefers the lead's own phrase; only a lead no clause cut can fit
// falls back to deleting function words. The fallback is reported so the scorer
// can treat a thinned title as telegraphic.
function finalizeProseLead(source: string): { title: string; compressed: boolean } {
	// The phrase cut and the fallback are the English path. A Chinese lead is
	// already a phrase from the text; the English width test would mark it
	// telegraphic for no reason.
	if (CJK_RUN_RE.test(source)) {
		return { title: finalizeTitle(source, false), compressed: false };
	}

	const { phrase, fits } = cutEnglishLeadPhrase(source);
	return { title: finalizeTitle(phrase, !fits), compressed: !fits };
}

// The prose candidate of one span: Chinese prose is taken as a phrase, anything
// else walks tokens to the next punctuation after the title target, which keeps
// one-word sentences ("Wait.") from titling. This function only shapes a
// candidate; the pool decides.
function deriveProseCandidate(
	text: string,
	from: number,
	allowTail = false,
	limit = text.length
): ProseCandidate | null {
	const compressed = deriveCompressedLeadTitle(text, from, allowTail, limit);
	if (compressed) {
		return compressed;
	}

	const cut = cutTitleAtPunctuation(text.slice(from, limit));
	const cleaned = cleanTitleSource(cut.title);
	if (Array.from(cleaned.title).length < TITLE_MIN_CHARS) {
		return null;
	}

	// "The problem is simple: find the maximum…" — the cut stopped at a colon
	// that only frames the task, and the task behind it is the title. The same
	// holds for a lead naming only the step and for a discourse frame before a
	// comma ("Based on the provided context, silicon has…").
	const contextFrame = CONTEXT_FRAME_RE.test(cleaned.title);
	if (
		FRAME_TITLE_RE.test(cleaned.title) ||
		PROCESS_FRAME_RE.test(cleaned.title) ||
		contextFrame ||
		VAGUE_ASK_LABEL_RE.test(cleaned.title)
	) {
		const separator = text[from + cut.consumed - 1];
		const separated =
			separator === ':' || separator === '：' || (separator === ',' && contextFrame);
		if (separated && text.slice(from + cut.consumed).trim()) {
			const retry = deriveProseCandidate(text, from + cut.consumed, true, limit);
			if (retry) {
				return { ...retry, abridged: true };
			}
		}
	}

	// A checklist opener is a process beat rather than a topic; the scorer
	// penalizes it instead of rejecting the candidate, so a block whose only
	// reading is a checklist can still title itself.
	const { title, compressed: thinned } = finalizeProseLead(cleaned.title);

	// A block is only titled when something follows its lead. A retry behind a
	// frame may run to the end: the frame was consumed, so the body keeps the
	// original text.
	if (!allowTail && !text.slice(from + cut.consumed).trim()) {
		return null;
	}

	return {
		title,
		consumed: from + cut.consumed,
		// The title no longer reproduces the consumed region (framing lifted,
		// words thinned, or the candidate starts after the block's opening
		// sentence), so the body keeps the original.
		abridged: from > 0 || cleaned.abridged || title !== cleaned.title,
		compressed: thinned
	};
}

// A lead that only frames the task ("the problem is simple") is no title: what
// follows its colon is. A stripped frame's predicate counts as a frame too.
const FRAME_TITLE_RE =
	/^(?:(?:the|a|an)\s+)?(?:(?:problem|question|task|goal|objective|issue|challenge|request|instructions?|exercise|assignment)\s+(?:is\s+)?(?:simple|clear|easy|straightforward|trivial|following|below|states?|says?|mentions?|notes?|describes?|reads?)|problem|question|task|goal|objective|challenge|exercise|simpl[ey]|clear|easy|straightforward|trivial|obvious|following|below)$/iu;

// The same in process words: a short lead that only names the step is no title,
// and a structural label ("time complexity") names no topic.
const PROCESS_FRAME_RE =
	/^(?:divide|multiply|compute|calculate|expand|simplify|solve|check|verify|substitute|differentiate|integrate|condition|basis|setup|analysis|approach|method|result|answer|solution|conclusion|state|note|recall|remember|time|space|edge|given)(?:\s+\S+){0,2}$/iu;

// A discourse frame ("Based on the provided context, …") frames what follows: the
// title starts after its comma, the way a task frame starts after its colon.
const CONTEXT_FRAME_RE =
	/^(?:based on|according to|from|per|given) (?:the )?(?:provided |given |above |following )?(?:context|passage|text|article|paragraph|sentence|information|data|problem|question|task|statement)$/iu;

// A restated request that only labels the ask ("a nuanced problem") names the
// shape of the question, not its topic: the clause behind its colon does.
const VAGUE_ASK_LABEL_RE =
	/^(?:(?:a|an|the)\s+)?(?:(?:very|really|quite|genuinely|fairly|rather)\s+)?(?:nuanced|common|classic|tricky|complex|interesting|important|subtle|hard|real|genuine|deep|thoughtful|practical)\s+(?:problem|question|challenge|issue|tensions?|topics?|subject)$/iu;

// A label that only names the shape of the answer ("The problem requires:")
// leaves the topic to the first item of the list behind it.
const META_LABEL_RE =
	/^(?:(?:the )?(?:user|problem|question|task|prompt|assignment|exercise|requirements?)\s+(?:asks?(?: for)?|wants?|requires?|states?|says?|needs?|is|describes?|includes?|specifies?)|(?:可能|大致|基本|具体)?的?步骤|(?:总结|小结|概述|综上)(?:一下|如下)?|(?:举例|例子|示例)说明?|(?:答案|结果|结论|分析|思路|方法|方案|内容|说明|备注|注意)(?:如下)?)$/iu;

// The title a weak label leaves to its list: the first item's own lead, cut and
// cleaned like a title. The list stays in the body.
function deriveListLeadTitle(blockText: string, lineEnd: number): TitleCandidate | null {
	const itemStart = lineEnd + 1;
	const itemEnd = blockText.indexOf('\n', itemStart);
	const itemLine = blockText.slice(itemStart, itemEnd === -1 ? blockText.length : itemEnd).trim();
	const item = /^(?:[-*+]|\d+[.)])\s+(.+)$/.exec(itemLine);
	if (!item) {
		return null;
	}
	const bold = /^(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(item[1]);
	const source = (bold ? bold[1] : item[1]).trim();
	if (!source) {
		return null;
	}
	const cut =
		CJK_RUN_RE.test(source) && !/^\s*[A-Za-z]/.test(source)
			? source.split(/[，、；：]/u)[0].trim()
			: cutTitleAtPunctuation(source).title;
	const cleaned = cleanTitleSource(cut).title;
	const title = CJK_RUN_RE.test(cleaned) ? finalizeChineseLead(cleaned) : finalizeTitle(cleaned);
	// A requirement's list item is the task itself, so it may open on an action
	// verb where an arbitrary sentence would read as process noise.
	if (
		!title ||
		Array.from(title).length < TITLE_MIN_CHARS ||
		isWeakLabelTitle(title) ||
		TOPIC_ADVERB_RE.test(title) ||
		TOPIC_PLAN_FILLER_RE.test(title) ||
		FRAME_TITLE_RE.test(title) ||
		PROCESS_FRAME_RE.test(title) ||
		isFormulaFragmentTitle(title) ||
		isConnectiveFrameTitle(title)
	) {
		return null;
	}
	return { title, consumed: 0, abridged: true };
}

// "evaluate each option" — the reasoning's checklist, not the block's topic.
const TOPIC_CHECKLIST_RE =
	/^(?:evaluate|consider|assess|review|examine|analyze|analyse|check|list|go through|look at|work through)\s+(?:each|every|all)\b/iu;

// A cut or a bracket drop can leave a dangling operator at a title's end: a
// title never ends on one. A lone trailing "+" stays — it names a branch of a ± split.
function stripTrailingTitleOperators(title: string): string {
	let text = title;
	for (;;) {
		const next = text.replace(/(?:[\s=±×÷·]+|[-−–—])+$/u, '').trimEnd();
		if (next === text || Array.from(next).length < TITLE_MIN_CHARS) {
			return text;
		}
		text = next;
	}
}

// A title renders as one line, so scripts are spaced the way the line reads:
// no space between CJK words, exactly one between CJK and Latin or a number.
function normalizeTitleSpacing(title: string): string {
	return title
		.replace(
			/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s+(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu,
			''
		)
		.replace(/(?<=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\s*(?=[A-Za-z0-9])/gu, ' ')
		.replace(/(?<=[A-Za-z0-9])\s*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

// The finished title: prose cleanup, shaping (width fit; unclosed brackets,
// unpaired quotes and dangling operators come off), then one-line spacing.
// `compress` is false for a phrase already cut from the text: its words are kept
// as written, because deleting function words is the fallback for a phrase that
// did not fit.
function finalizeTitle(source: string, compress = true): string {
	let title = compress ? stripEnglishFunctionWords(source) : source;
	title = stripTitlePunctuation(title);
	title = stripMathDelimiters(title);

	title = fitTitleWidth(title);
	title = dropUnclosedBrackets(title);
	title = dropUnpairedQuoteMarks(title);
	title = stripTrailingTitleOperators(title);

	return normalizeTitleSpacing(title);
}

// A lowercase word at the start reads as a sentence lead, so it is capitalised.
// Formula fragments, variables, code identifiers and mixed-case brands keep
// their casing.
const TITLE_LEAD_WORD_RE = /^(\p{Ll}[\p{L}\p{M}]*(?:['’-][\p{L}\p{M}]+)*)(?=$|[\s.,;:!?…])/u;

const SINGLE_LETTER_TITLE_WORDS = new Set(['a', 'i']);

function capitalizeTitleLead(title: string): string {
	const match = TITLE_LEAD_WORD_RE.exec(title);
	if (!match) {
		return title;
	}

	const word = match[1];

	// A lone letter is a variable ("x"), not a word, unless it is "a" or "i"
	// with text behind it rather than an operator ("a + b", "i.e.").
	if (Array.from(word).length === 1) {
		if (!SINGLE_LETTER_TITLE_WORDS.has(word)) {
			return title;
		}
		const rest = title.slice(1);
		if (!/^\s+\S/u.test(rest) || /^[+−=×÷*/^<>≤≥≈,;:.…-]/.test(rest.trimStart())) {
			return title;
		}
	}

	// A hyphen chain of single letters ("x-y", "a-b") is arithmetic, not a
	// hyphenated word.
	if (word.includes('-') && word.split('-').every((part) => Array.from(part).length === 1)) {
		return title;
	}

	// Mixed-case brands and identifiers ("iPhone", "iOS", "eBay") already carry
	// their intended casing.
	if (word !== word.toLowerCase()) {
		return title;
	}

	const [first] = Array.from(title);
	return first.toUpperCase() + title.slice(first.length);
}

// The title a long quoted span carries. The quote is taken as written: it may
// open with a question word.
function quotedTitle(source: string): string | null {
	const cut = cutTitleAtPunctuation(source);
	const title = finalizeTitle(cleanTitleSource(cut.title).title);
	return Array.from(title).length >= TITLE_MIN_CHARS ? title : null;
}

// A width cut or a clause cut can leave a bracket without its closer: everything
// from the first unclosed opener on is dropped.
function dropUnclosedBrackets(title: string): string {
	const openers: number[] = [];
	for (let i = 0; i < title.length; i++) {
		const char = title[i];
		if ('([{（【'.includes(char)) {
			openers.push(i);
		} else if (')]}）】'.includes(char)) {
			openers.pop();
		}
	}

	if (openers.length === 0) {
		return title;
	}

	const kept = title.slice(0, openers[0]).trimEnd();
	return Array.from(kept).length >= TITLE_MIN_CHARS ? kept : title;
}

// Markers that make a sentence or title read like a formula ("f(x) = …", "x²",
// "\frac") rather than a statement.
const FORMULA_MARK_RE = /[=^_$\\]|[ⁿ⁰¹²³⁴⁵⁶⁷⁸⁹]|[≤≥≠≈±×÷√∑∫∏∞→←∈∉⊂⊆∪∩]/gu;

function formulaMarks(text: string): number {
	return [...text.matchAll(FORMULA_MARK_RE)].length;
}

// A second sentence that opens with one of these restates the task or sums the
// first sentence up.
const SECOND_SENTENCE_OPENER_RE =
	/^(?:(?:so|thus|therefore|hence|overall|in (?:summary|short)|to (?:summarize|sum up))\b|所以|因此|于是|所有|综上|总之|那么)\s*[,，、:：]?\s*/iu;

// A later sentence that opens with a statement of intent ("Let me…", "I'll…")
// is more likely to carry the topic than the sentences around it; a discourse
// marker in front does not hide it. Every such sentence becomes a candidate.
const TOPIC_INTENT_RE =
	/^(?:(?:现在|那么|好|嗯|呃|ok|okay|well|now|so|alright|next|then)\s*[,，、:：]?\s*)?(?:let me|let us|let[’']s|i[’']ll|i will|i[’']d|i can|i could|i want to|i need to|i should|i[’']m going to|we[’']ll|we will|we need to|we should|让我|我来|我会|我可以|我能|我应该|我需要|我们需要|我们应该|我打算)/iu;

// An English sentence that restates the request carries the task, wherever it
// sits in the block.
const TOPIC_ASKER_RE =
	/^(?:the )?(?:user|question|problem|task|prompt)(?: message)?(?: asks?| asked| is asking| says?| said| is saying| saying| states?| stated| mentions?| mentioned| greets?| greeted| requires?| required| wants?| wanted| needs?| needed| expects?| expected)\b/iu;

// Chinese first-person / asker framing that opens a turn but does not name its
// topic ("用户又在叫我…", "让我继续…"): a later sentence is the topic.
const CHINESE_FRAMING_RE =
	/^(?:(?:用户|我|我们|咱们|你|你们|他|她|他们)(?:又|还|也|现在|正在|刚刚|刚才|在|先|再|就)*?)?(?:叫|让|要求|请求|希望|想要|想|问|说|提醒|催促|告诉|提出)/u;

// A title that opens with a process verb or a conversational beat ("wait",
// "hold on", "here's…") is a note about how the reasoning proceeds, not a topic.
const TOPIC_PROCESS_CORE_RE =
	/^(?:(?:think|rethink|reconsider|recheck|double-?check|check|verify|redo|recompute|compute|calculate|count|try|attempt|look|see|step|start|begin|continue|create|make|provide|produce|write|draft|prepare|structure|organize|organise|break|cover|ensure|include|set|build|plan|tackle|handle|equate|factor|guess|be|do|go|take|work|share|use|engage|evaluate|consider|assess|review|examine|analyze|analyse|identify|multiply|divide|expand|subtract|simplify|substitute|i|we|you|they|he|she|it)\b|(?:hmm+|hm+|wait|hold|oh|ah|here|search|stop|run|double|just|really|no|yes|not|instead|and|or|but|if|then|with|from|also|again|still|unless|indeed|exactly|simply|clearly|obviously|note|recall|remember)\b|想|思考|考虑|检查|理解|分析|梳理|继续|先|并|并且|且|以及|然后|接着|同时|另外|此外|所以|因此|确保|保证|确认)/iu;

// Adverbs that read as noise only when a process word follows ("carefully
// think…" is noise, "genuinely deep philosophical question…" is not).
const TOPIC_ADVERB_RE =
	/^(?:carefully|really|just|simply|honestly|genuinely|systematically|thoroughly|differently|properly|correctly|仔细|认真|重新|逐步|慢慢|好好)\s*/iu;

// A candidate that starts with a code or SQL fragment names a line of code, not
// the block.
function isCodeLikeTitle(title: string): boolean {
	const trimmed = title.trim();
	return (
		// An identifier has a letter before the underscore ("user_id"); a
		// subscript base ("13_b") is math, not code.
		/[A-Za-z]_[A-Za-z0-9]/.test(trimmed) ||
		// A natural hyphen compound ("state-of-the-art", "well-formed") is
		// prose: the token layer keeps it one word, so it is not code.
		/^(?:def|class|import|function|const|let|var|public|private|return)\b/i.test(trimmed) ||
		/^(?:SELECT|INSERT|UPDATE|DELETE|WHERE|CREATE|ALTER|DROP|JOIN)\b/.test(trimmed)
	);
}

// A candidate that opens on an operator, a number or a bracket is a calculation
// step, not a topic.
function isFormulaFragmentTitle(title: string): boolean {
	const trimmed = title.trim();
	return /^[\d·×÷±=+<>≤≥≠≈→←√^_([{]/u.test(trimmed) && formulaMarks(trimmed) > 0;
}

// A sentence that only states a limit or growth condition opens on a connective
// and carries no content words: it frames the reasoning, it does not name it.
function isConnectiveFrameTitle(title: string): boolean {
	const trimmed = title.trim();
	return (
		/^(?:as|when|where|while|since)\b/iu.test(trimmed) &&
		formulaMarks(trimmed) > 0 &&
		contentWordCount(trimmed.replace(/^(?:as|when|where|while|since)\b/iu, '')) === 0
	);
}

// Action verbs that may open a title from a statement of intent: "Let's use the
// search tool…" names the task; "Let me first read the question" is a beat.
const TASK_TITLE_OPENER_RE =
	/^(?:使用|用|搜索|搜|查找|查询|检索|分享|写|编写|创建|设计|实现|构建|生成|开发|制作|运行|执行|整理|总结|计算|统计|处理|修改|调整|优化|测试|采集|抓取|获取|读取|加载|保存|输出|打印|下载|上传|安装|配置|部署|尝试|试着|(?:use|using|search|find|fetch|retrieve|query|implement|write|create|design|build|generate|develop|run|execute|compute|calculate|process|modify|adjust|optimize|test|download|upload|install|configure|deploy|read|load|save|output|print|try|attempt|check)\b)/iu;

// A plan that names no task ("use a different strategy") titles nothing, even
// from a statement of intent.
const TOPIC_PLAN_FILLER_RE =
	/^(?:(?:use|try|take|apply|follow|organize|organise|structure)\b[\s\S]*\b(?:strategy|approach|method|way|plan|steps?|response|answer|information|categories)\b|(?:使用|用|尝试|采用|按照|组织|整理|梳理)[\s\S]*(?:策略|方法|方式|步骤|回答|答案|信息|结构|思路))/iu;

// A closing sentence that says what the assistant will hand to the user names
// the block's takeaway: it titles even when narrower than the opening. A closing
// solution step does not.
const TOPIC_HANDOFF_RE =
	/^(?:report|respond|reply|answer|tell|share|explain|summari[sz]e|inform|mention|relay|present)\b|^(?:告诉|回复|回答|汇报|反馈|分享|解释|总结|说明|呈现)/iu;

// A statement of intent already names the task: `relaxed` lets its title open on
// an action verb where an arbitrary later sentence would read as process noise,
// and keeps every other test.
function isTopicTitle(title: string, relaxed = false): boolean {
	const trimmed = title.trim();
	const processFrame = TOPIC_PROCESS_CORE_RE.test(trimmed);
	if (
		TOPIC_ADVERB_RE.test(trimmed) ||
		(processFrame && (!relaxed || !TASK_TITLE_OPENER_RE.test(trimmed))) ||
		(relaxed && TOPIC_PLAN_FILLER_RE.test(trimmed)) ||
		FRAME_TITLE_RE.test(trimmed) ||
		PROCESS_FRAME_RE.test(trimmed) ||
		isCodeLikeTitle(trimmed) ||
		isFormulaFragmentTitle(trimmed) ||
		isConnectiveFrameTitle(trimmed)
	) {
		return false;
	}

	// A bare word or two does not name a topic.
	if (/[\u3400-\u9fff]/u.test(trimmed)) {
		return Array.from(trimmed).length >= 4;
	}

	return trimmed.split(/\s+/).filter(Boolean).length >= 2;
}

// "Solve this problem" names the reasoning beat; a formula framed by a condition
// is a lead-in. Both are weak frames, not rejections.
const GENERIC_TASK_TITLE_RE =
	/^(?:解决|处理|回答|分析|完成|做|看)(?:一下|这个|该|此)?(?:问题|题目|任务)$|^(?:solve|answer|tackle|handle|address|work on) (?:this|the) (?:problem|question|task)$/iu;
const FORMULA_CONDITION_TITLE_RE = /^\p{L}\s*\([^)]*\)\s+(?:as|when|where|while)\b/iu;

// Sentence and clause ends, used to decide whether a span reads as a finished
// sentence and whether a later sentence can serve as the fix-up candidate.
function sentenceEnds(text: string): boolean {
	return /[.。！？!?…，]$/u.test(text);
}

// Openers and tails that make a phrase read as a beat. They are penalties, not
// rejections: the score falls under the floor and the block renders titleless.
const TITLE_CONNECTIVE_OPENER_RE =
	/^(?:并且|并|而且|而|但是|但|不过|所以|因此|于是|然后|接着|同时|另外|此外|以及|或者|还是|这样|这么|那么|比如|譬如)/u;
const TITLE_CONNECTIVE_OPENER_ENGLISH_RE =
	/^(?:and|but|or|so|then|also|plus|however|though|although|yet|still|instead|as if|as though)\b/iu;
const TITLE_HEDGE_OPENER_RE =
	/^(?:可能|也许|或许|大概|大约|似乎|好像|应该|应当|需要|是否|能否|要不要|该不该)/u;
const TITLE_FRAMING_OPENER_RE =
	/^(?:用户|我|我们)(?:可能|也许|大概|似乎|应该|需要|又|还|也|现在|正在|没有|明确|暂时)*(?:不)?(?:提出|说|问|想|觉得|认为|希望|要求|需要|提到|提醒)/u;
// A sentence about the sentence ("The sentence describes…") or a plan about
// how to proceed ("work through this step by step") is a reasoning beat.
const TITLE_META_SENTENCE_RE =
	/^(?:the|this|that)\s+(?:sentence|text|passage|question|problem|prompt|task|statement)\s+(?:describes|says|states|asks|mentions|presents|implies)/iu;
const TITLE_STEP_PLAN_RE =
	/^(?:work|go|walk|talk|think|reason|step)\s+through\b|\bstep[- ]by[- ]step\b|\bone\s+step\s+at\s+a\s+time\b|^be\s+(?:more\s+)?(?:careful|precise|systematic|thorough|specific)\b/iu;
const TITLE_EVALUATIVE_TAIL_RE =
	/(?:挺|很|真|太|比较|非常|特别|有些|有点)(?:有意思|有趣|重要|简单|复杂|困难|容易|不错|合理|明显|棘手|麻烦)的?$/u;
const TITLE_QUESTION_TAIL_RE = /(?:[吗呢吧][？?]?|[?])$/u;
const TITLE_DANGLING_END_RE =
	/(?:的话|的|了|着|过|并|而|但|和|与|及|或|所以|因此|而且|并且|然后|以及|包括|例如|比如)$|[\s,]+(?:and|or|but|so|because|while|when|if|that|which|of|for|with|to|in|on|at|by|from|as|the|a|an)$/iu;
const TITLE_MARKUP_START_RE = /^\s*(?:#{1,6}\s|```|~~~|\*\*|__|\|)/;

// Whether a title ends on something a reader can hold onto: a whole CJK word
// that is not glue, or an English token that is not function or generic.
function titleEndsOnContentWord(title: string): boolean {
	const trimmed = title.trim().replace(TITLE_TRAILING_SEPARATORS_RE, '');
	if (!trimmed) {
		return false;
	}

	if (CJK_RUN_RE.test(trimmed)) {
		const last = wordSegments(trimmed).at(-1)?.word;
		if (!last || CJK_GLUE_CHARS.has(last)) {
			return false;
		}
		return !CHINESE_FUNCTION_WORD_SET.has(last);
	}

	const tokens = englishTokens(trimmed);
	const last = tokens.length - 1;
	if (last < 0) {
		return false;
	}
	return !isEnglishFunctionWord(tokens, last) && !GENERIC_ENGLISH_WORD_SET.has(tokens[last].lower);
}

// A run-on is not more specific than a phrase: past the width a title reads
// as a passage, each extra word or column costs a little.
function titleRunOnPenalty(title: string): number {
	const words = title.trim().split(/\s+/u).filter(Boolean).length;
	const width = displayWidth(title);
	const penalty =
		Math.max(0, words - 8) * TITLE_PENALTY_RUN_ON_WORD +
		Math.max(0, width - 44) * TITLE_PENALTY_RUN_ON_WIDTH;
	return Math.min(penalty, TITLE_PENALTY_RUN_ON_MAX);
}

// ---------------------------------------------------------------------------
// Sentence centrality (TextRank on the block)
//
// The block is its own corpus: sentences are nodes, edges are content-word
// cosine, and PageRank ranks them. Bags are IDF-weighted over the block's own
// sentences, so a repeated word cannot make a pair look alike; O(sentences² ·
// bag size), cached once per block, and candidates read the vector by index.
// ---------------------------------------------------------------------------

/** PageRank damping: the share of a sentence's rank passed to its neighbours. */
const SENTENCE_GRAPH_DAMPING = 0.85;
/** Power iteration stops at this many rounds even if it has not settled. */
const SENTENCE_GRAPH_MAX_ITERATIONS = 50;
/** Power iteration stops early once no rank moves by more than this. */
const SENTENCE_GRAPH_TOLERANCE = 1e-6;
const SENTENCE_GRAPH_CACHE_LIMIT = 64;
const sentenceGraphCache = new Map<string, number[]>();

/**
 * Content words under the same rules that count a title's content. Shared by the
 * sentence graph (per block) and the session IDF corpus, so the two stages
 * cannot disagree on what a content word is.
 */
function contentWordTerms(text: string): string[] {
	const words: string[] = [];

	if (!CJK_RUN_RE.test(text)) {
		const tokens = englishTokens(text);
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i];
			if (!/^[A-Za-z]{2,}/u.test(token.text)) {
				continue;
			}
			if (GENERIC_ENGLISH_WORD_SET.has(token.lower) || isEnglishFunctionWord(tokens, i)) {
				continue;
			}
			words.push(token.lower);
		}
		return words;
	}

	for (const part of wordSegments(text)) {
		if (CJK_RUN_RE.test(part.word)) {
			if (
				!CHINESE_FUNCTION_WORD_SET.has(part.word) &&
				Array.from(part.word).some((char) => !CJK_GLUE_CHARS.has(char))
			) {
				words.push(part.word);
			}
			continue;
		}
		if (!/^[A-Za-z]{2,}/u.test(part.word)) {
			continue;
		}
		if (GENERIC_ENGLISH_WORD_SET.has(part.word.toLowerCase())) {
			continue;
		}
		if (isDroppableEnglishUnit(part.word)) {
			continue;
		}
		words.push(part.word.toLowerCase());
	}

	return words;
}

/**
 * The cosine of two IDF-weighted bags. `weight` is per unique term, so the
 * similarity measures shared vocabulary rather than length.
 */
function cosineSimilarity(
	a: ReadonlyMap<string, number>,
	aNorm: number,
	b: ReadonlyMap<string, number>,
	bNorm: number
): number {
	if (aNorm === 0 || bNorm === 0) {
		return 0;
	}

	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let dot = 0;
	for (const [term, weight] of small) {
		const other = large.get(term);
		if (other !== undefined) {
			dot += weight * other;
		}
	}
	return dot / (aNorm * bNorm);
}

/**
 * PageRank over the block's sentence graph, rescaled to [0, 1] as the excess over
 * an even share: the most central sentence is 1, an average one 0. All-zero
 * scores mean no centre, so centrality never stands in for position there.
 */
function sentenceCentrality(blockText: string, sentences: readonly SentenceSpan[]): number[] {
	const cached = sentenceGraphCache.get(blockText);
	if (cached) {
		return cached;
	}

	const count = sentences.length;
	if (count === 0) {
		return [];
	}

	const bags = sentences.map((sentence) => new Set(contentWordTerms(sentence.text)));

	// Block-local IDF, with a smoothed document frequency so a term present in
	// every sentence still has a (small) weight and pairs are never all zero.
	const documentFrequency = new Map<string, number>();
	for (const bag of bags) {
		for (const term of bag) {
			documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
		}
	}
	const idf = (term: string): number =>
		Math.log((count + 1) / ((documentFrequency.get(term) ?? 0) + 1)) + 1;

	const vectors: Array<Map<string, number>> = [];
	const norms: number[] = [];
	for (const bag of bags) {
		const vector = new Map<string, number>();
		let norm = 0;
		for (const term of bag) {
			const weight = idf(term);
			vector.set(term, weight);
			norm += weight * weight;
		}
		vectors.push(vector);
		norms.push(Math.sqrt(norm));
	}

	// Undirected weighted graph. Empty content bags (a line of digits, a bare
	// "Approach:") add no edge and rank at the floor.
	const neighbours: Array<Array<{ index: number; weight: number }>> = Array.from(
		{ length: count },
		() => []
	);
	const outWeight = new Array<number>(count).fill(0);
	for (let i = 0; i < count; i++) {
		for (let j = i + 1; j < count; j++) {
			const weight = cosineSimilarity(vectors[i], norms[i], vectors[j], norms[j]);
			if (weight <= 0) {
				continue;
			}
			neighbours[i].push({ index: j, weight });
			neighbours[j].push({ index: i, weight });
			outWeight[i] += weight;
			outWeight[j] += weight;
		}
	}

	let rank = new Array<number>(count).fill(1 / count);
	for (let iteration = 0; iteration < SENTENCE_GRAPH_MAX_ITERATIONS; iteration++) {
		let dangling = 0;
		for (let i = 0; i < count; i++) {
			if (outWeight[i] === 0) {
				dangling += rank[i];
			}
		}

		const base = (1 - SENTENCE_GRAPH_DAMPING) / count + (SENTENCE_GRAPH_DAMPING * dangling) / count;
		const next = new Array<number>(count).fill(base);
		for (let i = 0; i < count; i++) {
			if (outWeight[i] === 0) {
				continue;
			}
			const share = (SENTENCE_GRAPH_DAMPING * rank[i]) / outWeight[i];
			for (const edge of neighbours[i]) {
				next[edge.index] += share * edge.weight;
			}
		}

		let delta = 0;
		for (let i = 0; i < count; i++) {
			delta = Math.max(delta, Math.abs(next[i] - rank[i]));
		}
		rank = next;
		if (delta < SENTENCE_GRAPH_TOLERANCE) {
			break;
		}
	}

	const even = 1 / count;
	const top = Math.max(...rank);
	const spread = top - even;
	// A centre shared by two or more sentences is not a centre: the graph says
	// both are equally representative, so the signal abstains instead of
	// handing a tie-breaking bonus to whichever comes later.
	const topShared = rank.filter((value) => top - value <= 1e-9).length > 1;
	const centrality =
		spread <= Number.EPSILON
			? new Array<number>(count).fill(0)
			: rank.map((value) =>
					topShared && top - value <= 1e-9 ? 0 : Math.max(0, (value - even) / spread)
				);

	if (sentenceGraphCache.size >= SENTENCE_GRAPH_CACHE_LIMIT) {
		sentenceGraphCache.clear();
	}
	sentenceGraphCache.set(blockText, centrality);
	return centrality;
}

// The sources that compete on centrality. The opening, intent, asker, task,
// quote and synthesis already carry a deliberate signal; paying centrality there
// would count the same sentence twice. What is left is the block's middle.
const TITLE_CENTRALITY_SOURCES: ReadonlySet<TitleSource> = new Set<TitleSource>([
	'later',
	'second',
	'clause',
	'fixup'
]);

// A central sentence still has to read as a topic. These openers make it a
// predicate fragment, a bare negation or demonstrative, a hypothetical premise,
// a sequencing beat or a plan opening on its action; position already keeps such
// a candidate down, and centrality must not lift it over the block's opening.
const TITLE_CENTRALITY_FRAGMENT_OPENER_RE =
	/^(?:是|为|即|没|没有|不|无|非|这|那|此|该|其|他|她|它|我|你|他们|我们|你们|最后|首先|其次|然后|接着|例如|比如|总之|综上|那么|其实|实际上|事实上|如果|假如|假设|不管|无论)/u;

function isCentralSentence(text: string): boolean {
	const trimmed = text.trim();
	return !(
		TITLE_CONNECTIVE_OPENER_RE.test(trimmed) ||
		TITLE_CONNECTIVE_OPENER_ENGLISH_RE.test(trimmed) ||
		TITLE_HEDGE_OPENER_RE.test(trimmed) ||
		TASK_TITLE_OPENER_RE.test(trimmed) ||
		TOPIC_ADVERB_RE.test(trimmed) ||
		TITLE_CENTRALITY_FRAGMENT_OPENER_RE.test(trimmed)
	);
}

// The ordinary and fallback score of one candidate. Both are one dot product
// over the same feature vector; the fallback table only discounts the soft
// penalties and adds the hedged-opener cost.
type TitleScore = { score: number; fallbackScore: number };

/** A zeroed feature vector for one candidate. */
function emptyTitleFeatures(): TitleFeatures {
	const features = {} as TitleFeatures;
	for (const name of TITLE_FEATURE_NAMES) {
		features[name] = 0;
	}
	return features;
}

/** One dot product over the features that fired (most of the vector is 0). */
function dotTitleFeatures(
	features: TitleFeatures,
	weights: Readonly<Record<TitleFeatureName, number>>
): number {
	let total = 0;
	for (const name of TITLE_FEATURE_NAMES) {
		const value = features[name];
		if (value !== 0) {
			total += value * weights[name];
		}
	}
	return total;
}

type TitleFeatureContext = {
	candidate: TitleCandidateMeta;
	title: string;
	sentenceCount: number;
	sentenceCentrality: readonly number[];
	contentIdf: ContentIdf;
	/** A definition or a template: both name their subject instead of quoting it. */
	composed: boolean;
	contentTerms: readonly string[];
	contentWords: number;
};

/** Everything the feature groups read, derived once per candidate. */
function titleFeatureContext(
	candidate: TitleCandidateMeta,
	title: string,
	sentenceCount: number,
	sentenceCentrality: readonly number[],
	contentIdf: ContentIdf
): TitleFeatureContext {
	const definition = candidate.source === 'definition';
	// A template names its work and, when it has one, its object. The object can
	// be a letter (`H(t)`), which the content-word counter does not see, so a
	// composed title is read as at least two content words — the same treatment
	// a definition gets for its symbol.
	const template = candidate.source === 'template';
	const composed = definition || template;
	const contentTerms = titleContentWordTerms(title);
	// A definition names its symbol even when the symbol is not a word: it is
	// scored as two content words, and the weak-label penalty is not applied.
	const contentWords = composed ? Math.max(2, contentTerms.length) : contentTerms.length;
	return {
		candidate,
		title,
		sentenceCount,
		sentenceCentrality,
		contentIdf,
		composed,
		contentTerms,
		contentWords
	};
}

/** One-hot source prior, sentence decay and masked centrality. */
function featureSourcePrior(features: TitleFeatures, context: TitleFeatureContext): void {
	const { candidate, sentenceCentrality } = context;
	const sourceKey = `src_${candidate.source.replace(/-/g, '_')}` as TitleFeatureName;
	if (sourceKey in features) {
		features[sourceKey] = 1;
	}
	if (candidate.source !== 'opening' && candidate.sentence > 1) {
		features.pos_decay = Math.min(
			TITLE_POSITION_SENTENCE_DECAY_CAP,
			(candidate.sentence - 1) * TITLE_POSITION_SENTENCE_DECAY
		);
	}
	if (TITLE_CENTRALITY_SOURCES.has(candidate.source)) {
		features.centrality_masked = sentenceCentrality[candidate.sentence] ?? 0;
	}
}

/** Specificity: the IDF aggregate for prose, a flat bonus for composed titles. */
function featureSpecificity(features: TitleFeatures, context: TitleFeatureContext): void {
	const { composed, contentTerms, contentIdf } = context;
	if (composed) {
		// A composed title (a definition or a template) is scored as a flat
		// two-content-word bonus: its object may be a symbol rather than a word,
		// which the IDF sum cannot count. Templates are additionally gated to
		// the fallback layer, so this bonus only decides whether one clears the
		// fallback floor, never whether it outranks a natural phrase.
		features.spec_definition = 1;
		return;
	}
	let weighted = 0;
	for (const term of contentTerms) {
		weighted += contentIdf.weights.get(term) ?? 1;
	}
	const baseline = Math.min(contentTerms.length, TITLE_SCORE_CONTENT_WORD_CAP);
	const capped = Math.min(weighted, TITLE_SCORE_CONTENT_WORD_CAP);
	// Weighted at most 1 per word, so the loss is bounded and cannot sink a
	// title position already ranked.
	features.spec_idf_sum_capped = capped;
	features.spec_content_word_count_capped = baseline;
	features.spec_idf_loss = Math.max(0, baseline - capped - TITLE_IDF_MAX_DISCOUNT);
}

/** Phrase-quality terms: ending, stated intent, handoff and run-on width. */
function featurePhraseQuality(features: TitleFeatures, context: TitleFeatureContext): void {
	const { candidate, title, sentenceCount } = context;
	if (titleEndsOnContentWord(title)) {
		features.title_ends_on_content_word = 1;
	}
	if (candidate.source === 'intent' && countReasoningTokens(title) >= TITLE_INTENT_QUALITY_TOKENS) {
		features.intent_quality = 1;
	}
	if (candidate.sentence === sentenceCount - 1 && TOPIC_HANDOFF_RE.test(title)) {
		features.topics_handoff = 1;
	}
	features.run_on_units = titleRunOnPenalty(title);
}

/**
 * Substance penalties: what the title is made of. `pen_numeric_run` is exclusive
 * of `pen_formula_fragment` (the hand scorer used `if / else if`, so a title that
 * is both pays once), and templates are exempt from the numeric run for the same
 * reason a stated intent is.
 */
function featureSubstancePenalties(features: TitleFeatures, context: TitleFeatureContext): void {
	const { candidate, title, contentWords } = context;
	if (isDiscourseMarkerOnly(title)) {
		features.pen_marker_only = 1;
	}
	if (isCodeLikeTitle(title)) {
		features.pen_code = 1;
	}
	const formulaFragment = isFormulaFragmentTitle(title);
	if (formulaFragment) {
		features.pen_formula_fragment = 1;
	} else if (
		formulaMarks(title) >= 2 &&
		candidate.source !== 'intent' &&
		// A template is composed from the block's work, so a symbol inside it
		// ("Narrow the root of Q4 numerically") is the object the title names,
		// not a numeric run. Same exemption as a stated intent.
		candidate.source !== 'template'
	) {
		features.pen_numeric_run = 1;
	}
	if (contentWords < 2) {
		features.pen_weak_label = 1;
	}
	if (
		FRAME_TITLE_RE.test(title) ||
		PROCESS_FRAME_RE.test(title) ||
		CONTEXT_FRAME_RE.test(title) ||
		VAGUE_ASK_LABEL_RE.test(title) ||
		META_LABEL_RE.test(title) ||
		TOPIC_CHECKLIST_RE.test(title) ||
		GENERIC_TASK_TITLE_RE.test(title) ||
		FORMULA_CONDITION_TITLE_RE.test(title)
	) {
		features.pen_frame = 1;
	}
	if (TOPIC_PROCESS_CORE_RE.test(title)) {
		if (CJK_RUN_RE.test(title)) {
			features.pen_process_opener = 1;
		} else {
			features.pen_process_opener_en = 1;
		}
	}
}

/** Opener and tail penalties: how the title phrases its topic. */
function featureOpenerPenalties(features: TitleFeatures, context: TitleFeatureContext): void {
	const { title } = context;
	if (!CJK_RUN_RE.test(title) && TITLE_META_COGNITION_OPENER_RE.test(title)) {
		features.pen_meta_cognition = 1;
	}
	if (TOPIC_PLAN_FILLER_RE.test(title)) {
		features.pen_plan_filler = 1;
	}
	if (TOPIC_ADVERB_RE.test(title)) {
		features.pen_adverb = 1;
	}
	if (CHINESE_FRAMING_RE.test(title) || TITLE_FRAMING_OPENER_RE.test(title)) {
		features.pen_framing = 1;
	}
	if (TITLE_HEDGE_OPENER_RE.test(title)) {
		features.pen_hedge_opener = 1;
	}
	if (TITLE_EVALUATIVE_TAIL_RE.test(title)) {
		features.pen_evaluative_tail = 1;
	}
	if (TITLE_QUESTION_TAIL_RE.test(title)) {
		features.pen_question_tail = 1;
	}
	if (TITLE_CONNECTIVE_OPENER_RE.test(title) || TITLE_CONNECTIVE_OPENER_ENGLISH_RE.test(title)) {
		features.pen_connective_opener = 1;
	}
	if (TITLE_META_SENTENCE_RE.test(title)) {
		features.pen_meta_sentence = 1;
	}
	if (TITLE_STEP_PLAN_RE.test(title)) {
		features.pen_step_plan = 1;
	}
	if (TITLE_DANGLING_END_RE.test(title)) {
		features.pen_dangling_end = 1;
	}
}

/** Metadata penalties: facts about the candidate rather than its wording. */
function featureMetadataPenalties(features: TitleFeatures, context: TitleFeatureContext): void {
	const { candidate, title, contentWords } = context;
	if (candidate.compressed) {
		features.pen_telegraphic = 1;
	}
	if (candidate.source === 'synthesis') {
		features.pen_synthesis = 1;
	}
	if (candidate.markup) {
		features.pen_markup = 1;
	}
	if (candidate.labelMerge) {
		features.pen_label_merge = 1;
	}
	if (candidate.listMerge) {
		features.pen_list_merge = 1;
	}
	if (candidate.codeLabel) {
		features.pen_code_label = 1;
	}
	// A one-word English title is a notes-column entry, not a topic. The weak
	// label penalty already covers framing words; this covers a concrete but
	// bare verb ("Recount").
	if (!CJK_RUN_RE.test(title) && contentWords === 1) {
		features.pen_single_word = 1;
	}
	if (candidate.source === 'intent' && candidate.sentence === 0 && context.sentenceCount === 1) {
		features.pen_whole_block_intent = 1;
	}
}

/** The fallback layer's own term: a hedged opener on an otherwise usable phrase. */
function featureFallbackPenalty(features: TitleFeatures, context: TitleFeatureContext): void {
	if (TITLE_FALLBACK_LOW_CONFIDENCE_RE.test(context.title)) {
		features.fb_low_confidence = 1;
	}
}

/**
 * The feature vector of one candidate: every term the hand-tuned scorer read, in
 * `TITLE_FEATURE_NAMES` order. Groups own disjoint terms and write only 1 or a
 * point value, so the pass cannot depend on branch order.
 *
 * Two places need care, because the old scorer was not a plain sum:
 *
 * 1. `pen_numeric_run` is exclusive of `pen_formula_fragment`: an `if / else if`
 *    branch paid one penalty, not two, and the feature keeps that precedence.
 * 2. `spec_content_word_count_capped` is the upper bound the IDF loss is measured
 *    against, carried as its own weighted feature instead of folded in.
 *
 * Ported 1:1 from the GRPO feature extractor (`ReasoningSummary/features.md`),
 * which reproduced the hand scorer to 2.84e-14 over 36,173 candidates.
 */
function extractTitleFeatures(
	candidate: TitleCandidateMeta,
	sentenceCount: number,
	sentenceCentrality: readonly number[] = [],
	contentIdf: ContentIdf = NEUTRAL_CONTENT_IDF
): TitleFeatures {
	const title = candidate.title.trim();
	const features = emptyTitleFeatures();
	if (!title) {
		return features;
	}

	const context = titleFeatureContext(
		candidate,
		title,
		sentenceCount,
		sentenceCentrality,
		contentIdf
	);
	featureSourcePrior(features, context);
	featureSpecificity(features, context);
	featurePhraseQuality(features, context);
	featureSubstancePenalties(features, context);
	featureOpenerPenalties(features, context);
	featureMetadataPenalties(features, context);
	featureFallbackPenalty(features, context);

	return features;
}

// The score of one candidate. Pure: everything it reads comes in as an argument,
// so a candidate can be re-scored without touching the block. `centrality` is
// already masked to sentences that read as topics; `contentIdf` is neutral for
// one block.
function scoreTitleCandidate(
	candidate: TitleCandidateMeta,
	sentenceCount: number,
	sentenceCentrality: readonly number[] = [],
	contentIdf: ContentIdf = NEUTRAL_CONTENT_IDF
): TitleScore {
	if (!candidate.title.trim()) {
		return { score: Number.NEGATIVE_INFINITY, fallbackScore: Number.NEGATIVE_INFINITY };
	}
	const features = extractTitleFeatures(candidate, sentenceCount, sentenceCentrality, contentIdf);
	return {
		score: dotTitleFeatures(features, TITLE_SCORE_WEIGHTS),
		fallbackScore: dotTitleFeatures(features, TITLE_FALLBACK_WEIGHTS)
	};
}

// End indices of the clause separators inside a sentence span. Chinese commas
// are already sentence ends here; 、；： and English ,;: still split a span.
function findClauseBreakEnds(text: string, start: number, end: number): number[] {
	const breaks: number[] = [];
	let inMath = false;
	let inCode = false;

	for (let i = start; i < end; i++) {
		const char = text[i];
		if (char === '`') {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			continue;
		}
		if (char === '$') {
			inMath = !inMath;
			continue;
		}
		if (inMath) {
			continue;
		}

		if (/[，、；：,;:]/u.test(char)) {
			if (char === ':' && /\d/u.test(text[i - 1] ?? '') && /\d/u.test(text[i + 1] ?? '')) {
				continue;
			}
			if (char === ':' && text[i + 1] === '/') {
				continue;
			}
			if (i > start && i + 1 < end) {
				breaks.push(i + 1);
			}
			continue;
		}

		if (
			(char === '—' || char === '–' || char === '-') &&
			/\s/u.test(text[i - 1] ?? '') &&
			/\s/u.test(text[i + 1] ?? '')
		) {
			const before = /(\S+)\s*$/u.exec(text.slice(start, i))?.[1] ?? '';
			const after = /^\s*(\S+)/u.exec(text.slice(i + 1, end))?.[1] ?? '';
			if (!isSubtractionDash(before, after) && i > start && i + 1 < end) {
				breaks.push(i + 1);
			}
		}
	}

	return breaks;
}

// The starts of the task sentences behind a label colon. A colon inside a time or
// URL is not a label.
function findLabelTaskStarts(text: string, start: number, end: number): number[] {
	const starts: number[] = [];
	let inMath = false;
	let inCode = false;

	for (let i = start; i < end; i++) {
		const char = text[i];
		if (char === '`') {
			inCode = !inCode;
			continue;
		}
		if (inCode) {
			continue;
		}
		if (char === '$') {
			inMath = !inMath;
			continue;
		}
		if (inMath) {
			continue;
		}
		if (char !== '：' && char !== ':') {
			continue;
		}
		if (char === ':' && /\d/u.test(text[i - 1] ?? '') && /\d/u.test(text[i + 1] ?? '')) {
			continue;
		}
		if (char === ':' && text[i + 1] === '/') {
			continue;
		}

		const next = i + 1 + (/^\s*/u.exec(text.slice(i + 1, end))?.[0].length ?? 0);
		if (next < end && !starts.includes(next)) {
			starts.push(next);
		}
	}

	return starts;
}

// The English phrase kept as written. The compressed candidate deletes function
// words only when no clause cut fits; this variant lets the scorer prefer the
// full phrase when it still reads as a title. Chinese already keeps its phrase.
function deriveVerbatimCandidate(text: string, start: number, end: number): ProseCandidate | null {
	const cut = cutTitleAtPunctuation(text.slice(start, end));
	const cleaned = cleanTitleSource(cut.title);
	if (Array.from(cleaned.title).length < TITLE_MIN_CHARS || CJK_RUN_RE.test(cleaned.title)) {
		return null;
	}

	// The variant only repairs a thinned title: one dropped function word is the
	// ordinary cleanup, two or more is where the grammar goes. With no telegraphic
	// fallback there is nothing to repair.
	if (countDroppableEnglishWords(cleaned.title) < 2) {
		return null;
	}

	const title = finalizeTitle(cleaned.title, false);
	if (Array.from(title).length < TITLE_MIN_CHARS) {
		return null;
	}

	return { title, consumed: start + cut.consumed, abridged: true, compressed: false };
}

// ---------------------------------------------------------------------------
// Verb-phrase synthesis
//
// A span may still be a process beat ("Let me analyze this problem") or lose the
// article carrying its object. This pass composes one 状语 + 动词 + 宾语 (or verb
// + object NP) from a closed verb table plus an object-boundary test, and only
// enters the pool when both boundaries are certain. The lexicon stays tiny on
// purpose: a full noun lexicon would be a second grammar.
// ---------------------------------------------------------------------------

// Action verbs a title may open on. Closed on purpose: a word outside this table
// is not a verb for the synthesizer, so a noun phrase cannot pass by guesswork.
const CHINESE_ACTION_VERBS = new Set([
	'实现',
	'开发',
	'设计',
	'搭建',
	'构建',
	'创建',
	'制作',
	'编写',
	'写',
	'重写',
	'生成',
	'计算',
	'统计',
	'解析',
	'检查',
	'排查',
	'修复',
	'优化',
	'部署',
	'配置',
	'分析',
	'识别',
	'提取',
	'转换',
	'处理',
	'使用',
	'验证',
	'测试',
	'收集',
	'整理',
	'总结',
	'搜索',
	'查找',
	'查询',
	'检索',
	'读取',
	'加载',
	'保存',
	'输出',
	'打印',
	'下载',
	'上传',
	'安装',
	'运行',
	'执行',
	'修改',
	'调整',
	'支持',
	'回答',
	'解释',
	'说明',
	'比较',
	'排序',
	'分割',
	'拆分',
	'合并',
	'训练',
	'预测',
	'分类',
	'推荐',
	'绘制',
	'列出',
	'评估',
	'审查',
	'核对',
	'记录',
	'存储',
	'删除',
	'更新',
	'替换',
	'重命名',
	'压缩',
	'解压',
	'加密',
	'解密',
	'过滤',
	'筛选',
	'匹配',
	'遍历',
	'扫描',
	'抓取',
	'采集',
	'渲染',
	'编译',
	'调试',
	'监控',
	'备份',
	'恢复',
	'迁移',
	'归档',
	'格式化',
	'序列化',
	'反序列化',
	'调用',
	'描述'
]);

// Prepositions that introduce the means of the action. A prefix starting with
// any other word is framing, and the phrase is skipped rather than shortened.
const CHINESE_TOOL_PREPOSITIONS = new Set([
	'用',
	'借助',
	'通过',
	'利用',
	'采用',
	'基于',
	'以',
	'拿',
	'靠',
	'凭',
	'根据',
	'按照',
	'依照'
]);

const CHINESE_SYNTHESIS_PREFIX_MAX_WORDS = 4;
const CHINESE_SYNTHESIS_OBJECT_MAX_WORDS = 14;
const CHINESE_SYNTHESIS_OBJECT_MAX_WIDTH = 40;

const CHINESE_SYNTHESIS_INTERROGATIVES = new Set([
	'如何',
	'怎么',
	'怎样',
	'为什么',
	'为何',
	'是否',
	'能否',
	'什么',
	'哪些',
	'哪个',
	'多少'
]);

// A result complement belongs to the verb ("拆分成", "转换为"), so it is kept
// before the object starts.
const CHINESE_VERB_COMPLEMENTS = new Set([
	'成',
	'为',
	'到',
	'出',
	'入',
	'回',
	'完',
	'好',
	'掉',
	'开',
	'起来',
	'下来',
	'下去'
]);

// A purpose connector can sit between the object and a second verb, keeping that
// verb in the phrase. A bare second verb ends the first phrase.
const CHINESE_PURPOSE_CONNECTORS = new Set(['来', '去', '以']);

const CHINESE_OBJECT_LEADING_PARTICLES = new Set(['了', '着', '过']);

// Words that end an object: conjunctions start a new predicate, a final particle
// closes the clause.
const CHINESE_OBJECT_STOP_WORDS = new Set([
	'并且',
	'并',
	'而且',
	'而',
	'但',
	'但是',
	'不过',
	'然后',
	'接着',
	'同时',
	'另外',
	'此外',
	'以及',
	'或者',
	'或',
	'还是',
	'以便',
	'从而',
	'进而',
	'因为',
	'所以',
	'因此',
	'如果',
	'假如',
	'即使',
	'虽然',
	'尽管',
	'既然',
	'只要',
	'只有',
	'除非',
	'无论',
	'不管',
	'不论',
	'要么',
	'要是',
	'一旦',
	'万一',
	'哪怕',
	'就算',
	'而是',
	'就是',
	'只是',
	'的话',
	'的时候',
	'时候',
	'等等',
	'之类',
	'以后',
	'之后',
	'以前',
	'之前',
	'后',
	'前',
	'时',
	'会',
	'能',
	'可以',
	'可能',
	'应该',
	'应当',
	'需要',
	'必须',
	'要',
	'将',
	'正在',
	'已经',
	'再',
	'也',
	'还',
	'就',
	'都',
	'又',
	'和',
	'与',
	'及',
	'吗',
	'呢',
	'吧',
	'啊',
	'呀',
	'啦',
	'嘛'
]);

const CLAUSE_PUNCTUATION_GAP_RE = /[,，、；：。！？;:]/u;

/** Whether clause punctuation sits between two words (a pause the object stops at). */
function hasClausePunctuationGap(
	text: string,
	before: { end: number },
	after: { start: number }
): boolean {
	return CLAUSE_PUNCTUATION_GAP_RE.test(text.slice(before.end, after.start));
}

// The segmenter may split a verb into several words (读取 arrives as 读 + 取),
// so a verb is matched as its own word sequence, longest first, bucketed.
type ChineseVerbEntry = { verb: string; tokens: string[] };

const CHINESE_ACTION_VERB_INDEX = new Map<string, ChineseVerbEntry[]>();
for (const verb of CHINESE_ACTION_VERBS) {
	const tokens = wordSegments(verb).map((part) => part.word);
	const first = tokens[0];
	if (!first) {
		continue;
	}
	const bucket = CHINESE_ACTION_VERB_INDEX.get(first) ?? [];
	bucket.push({ verb, tokens });
	CHINESE_ACTION_VERB_INDEX.set(first, bucket);
}
for (const bucket of CHINESE_ACTION_VERB_INDEX.values()) {
	bucket.sort((a, b) => b.tokens.length - a.tokens.length || b.verb.length - a.verb.length);
}

/** A whole action verb at word index `at`, or null. */
function matchChineseActionVerb(
	text: string,
	words: readonly WordSegment[],
	at: number
): ChineseVerbEntry | null {
	const entries = CHINESE_ACTION_VERB_INDEX.get(words[at]?.word ?? '');
	if (!entries) {
		return null;
	}

	for (const entry of entries) {
		if (at + entry.tokens.length > words.length) {
			continue;
		}
		let matched = true;
		for (let i = 0; i < entry.tokens.length; i++) {
			if (words[at + i].word !== entry.tokens[i]) {
				matched = false;
				break;
			}
			if (i > 0 && hasClausePunctuationGap(text, words[at + i - 1], words[at + i])) {
				matched = false;
				break;
			}
		}
		if (matched) {
			return entry;
		}
	}
	return null;
}

function isChineseToolPrefix(prefix: WordSegment[], text: string): boolean {
	if (
		prefix.length === 0 ||
		prefix.length > CHINESE_SYNTHESIS_PREFIX_MAX_WORDS ||
		!CHINESE_TOOL_PREPOSITIONS.has(prefix[0].word)
	) {
		return false;
	}

	let content = false;
	for (let i = 0; i < prefix.length; i++) {
		const word = prefix[i].word;
		if (CHINESE_SYNTHESIS_INTERROGATIVES.has(word)) {
			return false;
		}
		if (i > 0 && hasClausePunctuationGap(text, prefix[i - 1], prefix[i])) {
			return false;
		}
		if (
			i > 0 &&
			word !== '来' &&
			word !== '去' &&
			!CHINESE_TOOL_PREPOSITIONS.has(word) &&
			!CHINESE_FUNCTION_WORD_SET.has(word) &&
			!CHINESE_OBJECT_LEADING_PARTICLES.has(word)
		) {
			content = true;
		}
	}

	return content;
}

// ---------------------------------------------------------------------------
// Verb-phrase synthesis skeleton
// ---------------------------------------------------------------------------

// One walk over verb and object; a language config supplies the tokens, verb
// table, lead guard, particles and object rules, with module-level hooks so a
// candidate allocates only its own matches.
type PhraseToken = { start: number; end: number };

type PhraseMatch = { span: number; text: string };

type PhraseObjectRule = {
	maxTokens: number;
	maxWidth: number;
	minWidth: number;
	stopWords: ReadonlySet<string>;
	relativeWords?: ReadonlySet<string>;
	relativeMax: number;
	/** Keep a second verb while the object is still one split compound. */
	compoundGuard: boolean;
	purpose?: ReadonlySet<string>;
};

type PhraseLanguage<T extends PhraseToken> = {
	tokens(source: string): readonly T[];
	/** How many leading tokens may hold the verb. */
	verbScan: number;
	matchVerb(source: string, tokens: readonly T[], at: number): PhraseMatch | null;
	/** The lead kept in front of the verb, '' when the language has none, null when it is no means phrase. */
	prefix(source: string, tokens: readonly T[], verbAt: number): string | null;
	openObject(
		source: string,
		tokens: readonly T[],
		verbAt: number,
		match: PhraseMatch
	): { cursor: number; verbText: string } | null;
	key(token: T): string;
	clauseGap(source: string, before: T, after: T): boolean;
	isVerb(source: string, tokens: readonly T[], at: number): boolean;
	assemble(prefix: string, verb: string, object: string): string;
	object: PhraseObjectRule;
};

const CHINESE_PHRASE_OBJECT: PhraseObjectRule = {
	maxTokens: CHINESE_SYNTHESIS_OBJECT_MAX_WORDS,
	maxWidth: CHINESE_SYNTHESIS_OBJECT_MAX_WIDTH,
	minWidth: 4,
	stopWords: CHINESE_OBJECT_STOP_WORDS,
	relativeMax: 0,
	compoundGuard: true,
	purpose: CHINESE_PURPOSE_CONNECTORS
};

const CHINESE_PHRASE_LANGUAGE: PhraseLanguage<WordSegment> = {
	tokens: wordSegments,
	verbScan: Number.MAX_SAFE_INTEGER,
	matchVerb(source, words, at) {
		const entry = matchChineseActionVerb(source, words, at);
		return entry ? { span: entry.tokens.length, text: '' } : null;
	},
	prefix(source, words, verbAt) {
		const prefix = words.slice(0, verbAt);
		if (!isChineseToolPrefix(prefix, source)) {
			return null;
		}
		return source.slice(prefix[0].start, prefix[prefix.length - 1].end);
	},
	openObject(source, words, verbAt, match) {
		let cursor = verbAt + match.span;
		let verbText = source.slice(words[verbAt].start, words[cursor - 1].end);

		// Particles right behind the verb are aspect markers, not the object.
		while (
			cursor < words.length &&
			CHINESE_OBJECT_LEADING_PARTICLES.has(words[cursor].word) &&
			!hasClausePunctuationGap(source, words[cursor - 1], words[cursor])
		) {
			cursor++;
		}

		const complement = words[cursor];
		if (
			complement &&
			CHINESE_VERB_COMPLEMENTS.has(complement.word) &&
			!hasClausePunctuationGap(source, words[cursor - 1], complement)
		) {
			verbText += complement.word;
			cursor++;
		}
		return { cursor, verbText };
	},
	key: (token) => token.word,
	clauseGap: hasClausePunctuationGap,
	isVerb: (source, words, at) => matchChineseActionVerb(source, words, at) !== null,
	assemble: (prefix, verb, object) => `${prefix}${verb}${object}`,
	object: CHINESE_PHRASE_OBJECT
};

// 状语 + 动词 + 宾语, or null when either boundary is uncertain. A verb behind a
// lead that is not a means phrase is skipped, so the result never loses the
// topic the lead carried ("如何通过编译预处理来实现…" is not just "实现…").
function synthesizeChineseVerbPhrase(source: string): string | null {
	return synthesizeVerbPhrase(source, CHINESE_PHRASE_LANGUAGE);
}

// ---------------------------------------------------------------------------
// English verb forms
// ---------------------------------------------------------------------------

const ENGLISH_ACTION_VERB_BASES: ReadonlyArray<string> = [
	'add',
	'analyze',
	'analyse',
	'apply',
	'assess',
	'build',
	'calculate',
	'check',
	'classify',
	'collect',
	'compare',
	'complete',
	'compute',
	'configure',
	'convert',
	'count',
	'create',
	'delete',
	'deploy',
	'design',
	'determine',
	'develop',
	'divide',
	'download',
	'evaluate',
	'examine',
	'execute',
	'expand',
	'explain',
	'extract',
	'factor',
	'fetch',
	'filter',
	'find',
	'generate',
	'group',
	'identify',
	'implement',
	'install',
	'iterate',
	'load',
	'locate',
	'merge',
	'modify',
	'multiply',
	'optimize',
	'organize',
	'parse',
	'predict',
	'print',
	'process',
	'produce',
	'query',
	'read',
	'record',
	'remove',
	'rename',
	'replace',
	'retrieve',
	'review',
	'run',
	'save',
	'scan',
	'search',
	'simplify',
	'sort',
	'split',
	'solve',
	'store',
	'substitute',
	'subtract',
	'summarize',
	'test',
	'trace',
	'track',
	'train',
	'transform',
	'translate',
	'update',
	'upload',
	'use',
	'validate',
	'verify',
	'write'
];

const ENGLISH_ACTION_VERB_FORMS = new Map<string, string>();
for (const base of ENGLISH_ACTION_VERB_BASES) {
	ENGLISH_ACTION_VERB_FORMS.set(base, base);
	ENGLISH_ACTION_VERB_FORMS.set(`${base}s`, base);
	if (/(?:s|x|z|ch|sh|o)$/u.test(base)) {
		ENGLISH_ACTION_VERB_FORMS.set(`${base}es`, base);
	}
	if (base.endsWith('e')) {
		ENGLISH_ACTION_VERB_FORMS.set(`${base}d`, base);
		ENGLISH_ACTION_VERB_FORMS.set(`${base.slice(0, -1)}ing`, base);
	} else if (/[^aeiou]y$/u.test(base)) {
		ENGLISH_ACTION_VERB_FORMS.set(`${base.slice(0, -1)}ies`, base);
		ENGLISH_ACTION_VERB_FORMS.set(`${base.slice(0, -1)}ied`, base);
	} else {
		ENGLISH_ACTION_VERB_FORMS.set(`${base}ed`, base);
		ENGLISH_ACTION_VERB_FORMS.set(`${base}ing`, base);
	}
}

// Irregular preterites and participles the regular endings cannot reach.
for (const [surface, base] of [
	['built', 'build'],
	['found', 'find'],
	['kept', 'keep'],
	['ran', 'run'],
	['read', 'read'],
	['split', 'split'],
	['wrote', 'write'],
	['written', 'write'],
	['made', 'make'],
	['took', 'take'],
	['given', 'give'],
	['got', 'get'],
	['saw', 'see'],
	['sent', 'send']
] as const) {
	ENGLISH_ACTION_VERB_FORMS.set(surface, base);
}

// A clause adverb may stand between the lead and the verb ("Then find…"). The
// cleaned lead has already lost the conversational words; these are the
// residue the phrase may keep in front of the verb.
const ENGLISH_SYNTHESIS_LEAD_WORDS = new Set([
	'then',
	'first',
	'now',
	'also',
	'please',
	'quickly',
	'carefully',
	'directly',
	'simply',
	'finally'
]);

// Phrasal particles that are part of the verb, not the object: "search for X"
// titles as "Search X". Other prepositions end the object NP instead.
const ENGLISH_VERB_PARTICLES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['search', new Set(['for'])],
	['look', new Set(['for', 'at', 'into'])],
	['find', new Set(['out'])],
	['trace', new Set(['through'])],
	['work', new Set(['through', 'on'])],
	['read', new Set(['through'])],
	['go', new Set(['through'])],
	['iterate', new Set(['through', 'over'])],
	['scan', new Set(['through'])],
	['filter', new Set(['out', 'by'])],
	['sort', new Set(['by'])],
	['group', new Set(['by'])]
]);

const ENGLISH_SYNTHESIS_RELATIVE_WORDS = new Set(['that', 'which', 'who', 'whom', 'whose']);

// The object NP ends where a new clause, a prepositional phrase or a predicate
// starts. The phrase keeps its determiner and adjectives; the head noun is the
// last content word before the boundary.
const ENGLISH_OBJECT_STOP_WORDS = new Set([
	'that',
	'which',
	'who',
	'whom',
	'whose',
	'where',
	'when',
	'why',
	'how',
	'because',
	'so',
	'but',
	'and',
	'or',
	'while',
	'if',
	'then',
	'than',
	'as',
	'with',
	'without',
	'from',
	'in',
	'on',
	'at',
	'for',
	'to',
	'of',
	'into',
	'over',
	'under',
	'through',
	'by',
	'within',
	'per',
	'about',
	'using',
	'via',
	'such',
	'including',
	'based'
]);

const ENGLISH_SYNTHESIS_OBJECT_MAX_TOKENS = 8;
const ENGLISH_SYNTHESIS_RELATIVE_MAX_TOKENS = 4;
const ENGLISH_SYNTHESIS_OBJECT_MAX_WIDTH = 48;

const ENGLISH_PHRASE_OBJECT: PhraseObjectRule = {
	maxTokens: ENGLISH_SYNTHESIS_OBJECT_MAX_TOKENS,
	maxWidth: ENGLISH_SYNTHESIS_OBJECT_MAX_WIDTH,
	minWidth: 4,
	stopWords: ENGLISH_OBJECT_STOP_WORDS,
	relativeWords: ENGLISH_SYNTHESIS_RELATIVE_WORDS,
	relativeMax: ENGLISH_SYNTHESIS_RELATIVE_MAX_TOKENS,
	compoundGuard: false
};

const ENGLISH_PHRASE_LANGUAGE: PhraseLanguage<EnglishToken> = {
	tokens: englishTokens,
	verbScan: 3,
	matchVerb(_source, tokens, at) {
		const base = ENGLISH_ACTION_VERB_FORMS.get(tokens[at].lower);
		if (!base) {
			return null;
		}
		if (at > 0 && !ENGLISH_SYNTHESIS_LEAD_WORDS.has(tokens[at - 1].lower)) {
			return null;
		}
		return { span: 1, text: base };
	},
	prefix: () => '',
	openObject(source, tokens, verbAt, match) {
		let cursor = verbAt + 1;
		const particles = ENGLISH_VERB_PARTICLES.get(match.text);
		if (particles && cursor < tokens.length && particles.has(tokens[cursor].lower)) {
			cursor++;
		}
		if (cursor >= tokens.length) {
			return null;
		}
		return { cursor, verbText: match.text };
	},
	key: (token) => token.lower,
	clauseGap: (source, before, after) => !isWhitespaceGap(source, before, after),
	isVerb: (_source, tokens, at) => ENGLISH_ACTION_VERB_FORMS.has(tokens[at].lower),
	assemble: (_prefix, verb, object) => `${verb} ${object}`,
	object: ENGLISH_PHRASE_OBJECT
};

// A second predicate behind a real object ends the phrase; behind a split
// compound ("条件编译") it is the noun's second half, so only a purpose
// connector may keep it.
function objectEndsOnVerb<T extends PhraseToken>(
	language: PhraseLanguage<T>,
	count: number,
	previous: T
): boolean {
	const rule = language.object;
	if (!rule.compoundGuard) {
		return true;
	}
	return count >= 2 && !rule.purpose?.has(language.key(previous));
}

// The object's own source span, or null when it is too short to read as a noun
// phrase (a one-character "object" is the segmenter splitting a word).
function phraseObjectText<T extends PhraseToken>(
	source: string,
	objectWords: readonly T[],
	minWidth: number
): string | null {
	if (objectWords.length === 0) {
		return null;
	}
	const text = source.slice(objectWords[0].start, objectWords[objectWords.length - 1].end);
	return displayWidth(text) >= minWidth ? text : null;
}

// The object NP ends where a new clause, a prepositional phrase or a predicate
// starts: the last whole token before that boundary is the head. The relative
// branch keeps "the option that best completes" whole and stops at its own verb.
function collectPhraseObject<T extends PhraseToken>(
	source: string,
	tokens: readonly T[],
	start: number,
	language: PhraseLanguage<T>
): string | null {
	const rule = language.object;
	const objectWords: T[] = [];
	let relativeStart = -1;

	for (let cursor = start; cursor < tokens.length; cursor++) {
		const token = tokens[cursor];
		if (objectWords.length > 0 && language.clauseGap(source, tokens[cursor - 1], token)) {
			break;
		}

		const count = objectWords.length;
		const verb = language.isVerb(source, tokens, cursor);
		const key = language.key(token);
		if (count === 0) {
			if (rule.stopWords.has(key) || verb) {
				break;
			}
		} else if (relativeStart >= 0) {
			if (count >= rule.maxTokens) {
				break;
			}
			objectWords.push(token);
			if (verb || count - relativeStart >= rule.relativeMax) {
				break;
			}
			continue;
		} else {
			if (count >= rule.maxTokens) {
				break;
			}
			if (rule.relativeWords?.has(key)) {
				relativeStart = count;
				objectWords.push(token);
				continue;
			}
			if (rule.stopWords.has(key)) {
				break;
			}
			if (verb && objectEndsOnVerb(language, count, objectWords[count - 1])) {
				break;
			}
		}

		objectWords.push(token);
		if (displayWidth(source.slice(objectWords[0].start, token.end)) > rule.maxWidth) {
			objectWords.pop();
			break;
		}
	}

	return phraseObjectText(source, objectWords, rule.minWidth);
}

// The shared synthesis engine: find the verb, keep its lead and particles, walk
// the object to its boundary, then assemble the phrase in the language's order.
function synthesizeVerbPhrase<T extends PhraseToken>(
	source: string,
	language: PhraseLanguage<T>
): string | null {
	const tokens = language.tokens(source);
	if (tokens.length < 2) {
		return null;
	}

	let verbAt = -1;
	let match: PhraseMatch | null = null;
	const scanEnd = Math.min(tokens.length, language.verbScan);
	for (let i = 0; i < scanEnd; i++) {
		match = language.matchVerb(source, tokens, i);
		if (match) {
			verbAt = i;
			break;
		}
	}
	if (!match) {
		return null;
	}

	let prefixText = '';
	if (verbAt > 0) {
		const prefix = language.prefix(source, tokens, verbAt);
		if (prefix === null) {
			return null;
		}
		prefixText = prefix;
	}

	const open = language.openObject(source, tokens, verbAt, match);
	if (!open) {
		return null;
	}
	const objectText = collectPhraseObject(source, tokens, open.cursor, language);
	if (!objectText) {
		return null;
	}
	return language.assemble(prefixText, open.verbText, objectText);
}

function synthesizeEnglishVerbPhrase(source: string): string | null {
	return synthesizeVerbPhrase(source, ENGLISH_PHRASE_LANGUAGE);
}

// The synthesized candidate of one sentence: a verb phrase when the language
// path recognizes one, otherwise null. The caller keeps the sentence's consumed
// end and marks the candidate abridged, since the phrase is not a verbatim span.
function deriveSynthesizedCandidate(
	text: string,
	start: number,
	end: number
): ProseCandidate | null {
	const cleaned = cleanTitleSource(text.slice(start, end)).title;
	if (Array.from(cleaned).length < TITLE_MIN_CHARS) {
		return null;
	}

	const phrase = CJK_RUN_RE.test(cleaned)
		? synthesizeChineseVerbPhrase(cleaned)
		: synthesizeEnglishVerbPhrase(cleaned);
	if (!phrase) {
		return null;
	}

	const title = finalizeTitle(stripDanglingTitleEnding(phrase), false);
	if (
		Array.from(title).length < TITLE_MIN_CHARS ||
		displayWidth(title) > REASONING_SUMMARY_TITLE_MAX_WIDTH ||
		titleContentWordCount(title) < 2
	) {
		return null;
	}

	return { title, consumed: end, abridged: true, compressed: false };
}

type CandidateMerge = { labelMerge: boolean; listMerge: boolean; codeLabel: boolean };

// Whether a candidate's consumed region runs past a label colon or a list
// separator, which glues a label to the first item behind it. A label colon that
// introduces a code block is a caption for the code, not the topic.
function candidateMergeFlags(
	text: string,
	start: number,
	end: number,
	consumed: number
): CandidateMerge {
	const length = Math.max(0, Math.min(end - start, consumed - start));
	const raw = text.slice(start, start + length);
	const colon = Math.max(raw.lastIndexOf('：'), raw.lastIndexOf(':'));
	const list = raw.indexOf('、');
	const after = text.slice(consumed).trimStart();
	return {
		labelMerge: CJK_RUN_RE.test(raw) && colon !== -1 && length > colon + 1,
		listMerge: list !== -1 && length > list + 1,
		codeLabel:
			/[：:]\s*$/u.test(raw) &&
			/^(?:```|~~~|#(?:define|include|if|ifdef|ifndef|else|elif|endif|pragma|undef)\b)/u.test(after)
	};
}

// Turns one prose candidate into a scored one, or null when it is too short to
// be a title at all (the one hard constraint besides the score floor).
function enhanceCandidate(
	candidate: TitleCandidate & { compressed?: boolean },
	source: TitleSource,
	sentence: number,
	markup: boolean,
	sentenceCount: number,
	centrality: readonly number[],
	contentIdf: ContentIdf,
	merge: CandidateMerge = { labelMerge: false, listMerge: false, codeLabel: false },
	continuationBonus = 0
): EnhancedCandidate | null {
	const title = candidate.title.trim();
	if (Array.from(title).length < TITLE_MIN_CHARS) {
		return null;
	}

	const base = {
		title,
		consumed: candidate.consumed,
		abridged: candidate.abridged,
		source,
		sentence,
		compressed: candidate.compressed === true,
		markup,
		labelMerge: merge.labelMerge,
		listMerge: merge.listMerge,
		codeLabel: merge.codeLabel
	};
	const scored = scoreTitleCandidate(base, sentenceCount, centrality, contentIdf);
	return {
		...base,
		score: scored.score + continuationBonus,
		fallbackScore: scored.fallbackScore + continuationBonus
	};
}

// ---------------------------------------------------------------------------
// Symbolic title templates
//
// The last title layer for a formula-dense block: with every sentence a
// calculation, no natural candidate survives the formula and numeric-run
// penalties. A template names the work instead of quoting it ("Solve for the
// positive roots of H(t)", "求解 H(t) 的正根") by classifying the block's signals
// (roots / simplify / factor / substitute / sign / derivative / bisect) and
// naming the symbol the formulas act on.
//
// Three rules keep it honest: it speaks only for a prose block of formula
// sentences (`TITLE_TEMPLATE_FORMULA_SENTENCE_SHARE`; lists, fences and tables
// never reach it); the language follows the block's CJK share; it is a fallback
// candidate, so eligibility requires that no natural candidate clears the
// fallback floor — specificity alone would otherwise let a clean template
// outscore a marginal natural title, and that rule lives in `chooseBestCandidate`.
// ---------------------------------------------------------------------------

type TitleTemplateCategory =
	| 'solve'
	| 'simplify'
	| 'factor'
	| 'evaluate'
	| 'sign'
	| 'transform'
	| 'narrow'
	| 'derive';

/** Share of sentences carrying a formula mark at which a block is formula-dense. */
const TITLE_TEMPLATE_FORMULA_SENTENCE_SHARE = 0.5;

/** One sentence is a lead, not a derivation: a template needs two. */
const TITLE_TEMPLATE_MIN_SENTENCES = 2;

/** A signal below this says too little to pick a category; `derive` takes over. */
const TITLE_TEMPLATE_MIN_SIGNAL = 1.5;

/** Categories within this margin of the best are a tie: the table order wins. */
const TITLE_TEMPLATE_TIE_MARGIN = 0.5;

/** The same signal repeated more often is not a different task. */
const TITLE_TEMPLATE_SIGNAL_MATCH_CAP = 3;

/** CJK share of non-space characters above which the block speaks Chinese. */
const TITLE_TEMPLATE_CJK_SHARE = 0.3;

/** An object that runs longer is an expression, not a symbol. */
const TITLE_TEMPLATE_OBJECT_MAX_LENGTH = 12;

/** Frequency a bare symbol needs before it can stand for the block's object. */
const TITLE_TEMPLATE_OBJECT_MIN_COUNT = 2;

/**
 * The block's signals, strongest first on a tie. English is matched on word
 * boundaries, Chinese as substrings (a Han word has no boundary to test).
 */
const TITLE_TEMPLATE_SIGNALS: ReadonlyArray<{
	category: Exclude<TitleTemplateCategory, 'derive'>;
	pattern: RegExp;
	weight: number;
}> = [
	// solve
	{ category: 'solve', pattern: /\bsolv(?:e|es|ed|ing)\b/giu, weight: 3 },
	{ category: 'solve', pattern: /\b(?:positive|negative|real|complex)\s+roots?\b/giu, weight: 3 },
	{ category: 'solve', pattern: /\broots?\b/giu, weight: 1.5 },
	{ category: 'solve', pattern: /求根|求解|解方程/gu, weight: 3 },
	{ category: 'solve', pattern: /正根|负根|实根|复根|零点/gu, weight: 3 },
	{ category: 'solve', pattern: /(?:的|方程)根/gu, weight: 2 },
	// simplify
	{ category: 'simplify', pattern: /\bsimplif(?:y|ies|ied|ying)\b/giu, weight: 3 },
	{ category: 'simplify', pattern: /\bexpand(?:s|ed|ing)?\b/giu, weight: 2 },
	{ category: 'simplify', pattern: /化简/gu, weight: 3 },
	{ category: 'simplify', pattern: /展开/gu, weight: 2 },
	{ category: 'simplify', pattern: /约去/gu, weight: 2 },
	// factor
	{ category: 'factor', pattern: /\bfactor(?:s|ed|ing|ization|ize|ise)?\b/giu, weight: 3 },
	{ category: 'factor', pattern: /因式分解|提出公因子|公因式|因式/gu, weight: 3 },
	// evaluate
	{ category: 'evaluate', pattern: /\bplug(?:s|ged|ging)?\b/giu, weight: 2 },
	{ category: 'evaluate', pattern: /\bsubstitut(?:e|es|ed|ing|ion)\b/giu, weight: 3 },
	{ category: 'evaluate', pattern: /\bevaluat(?:e|es|ed|ing)\s+at\b/giu, weight: 3 },
	{ category: 'evaluate', pattern: /\bevaluat(?:e|es|ed|ing)\b/giu, weight: 2 },
	{ category: 'evaluate', pattern: /代入/gu, weight: 3 },
	{ category: 'evaluate', pattern: /求值/gu, weight: 3 },
	// sign
	{ category: 'sign', pattern: /\bsigns?\b/giu, weight: 2 },
	{ category: 'sign', pattern: /\bpositive\b/giu, weight: 1 },
	{ category: 'sign', pattern: /\bnegative\b/giu, weight: 1 },
	{ category: 'sign', pattern: /正负|符号/gu, weight: 2 },
	{ category: 'sign', pattern: /不等式/gu, weight: 3 },
	{ category: 'sign', pattern: /大于|小于|不小于|不大于/gu, weight: 2 },
	// transform
	{
		category: 'transform',
		pattern: /\bderivatives?\b|\bdifferentiat(?:e|es|ed|ing|ion)\b/giu,
		weight: 3
	},
	{
		category: 'transform',
		pattern: /\bintegrals?\b|\bintegrat(?:e|es|ed|ing|ion)\b/giu,
		weight: 3
	},
	{ category: 'transform', pattern: /求导|导数|微分/gu, weight: 3 },
	{ category: 'transform', pattern: /积分/gu, weight: 3 },
	{ category: 'transform', pattern: /傅里叶|\bfourier\b/giu, weight: 3 },
	{ category: 'transform', pattern: /\btransforms?\b|\btransformation\b/giu, weight: 2 },
	{ category: 'transform', pattern: /变换/gu, weight: 2 },
	// narrow
	{ category: 'narrow', pattern: /\bbisect(?:s|ed|ing|ion)?\b/giu, weight: 3 },
	{ category: 'narrow', pattern: /\bnarrow(?:s|ed|ing)?\b/giu, weight: 2 },
	{ category: 'narrow', pattern: /二分/gu, weight: 3 },
	{ category: 'narrow', pattern: /缩到|缩小/gu, weight: 2 },
	{ category: 'narrow', pattern: /区间/gu, weight: 1.5 },
	{ category: 'narrow', pattern: /\bnumeric(?:al|ally)?\b/giu, weight: 1.5 },
	{ category: 'narrow', pattern: /数值/gu, weight: 1.5 }
];

/** Table order: equal or near-equal categories resolve to the earlier one. */
const TITLE_TEMPLATE_CATEGORY_ORDER: ReadonlyArray<Exclude<TitleTemplateCategory, 'derive'>> = [
	'solve',
	'simplify',
	'factor',
	'evaluate',
	'sign',
	'transform',
	'narrow'
];

type TitleTemplateForms = { withObject: string; withoutObject: string };

/**
 * The templates. `{obj}` is a symbol the block works on; without a usable symbol
 * the sentence-initial form still names the work ("Solve for the positive roots"
 * reads better than "Solve for the positive roots of"). Chinese keeps a space
 * around the symbol; English is written as a normal sentence.
 */
const TITLE_TEMPLATE_FORMS: Record<
	Exclude<TitleTemplateCategory, 'transform'>,
	{ zh: TitleTemplateForms; en: TitleTemplateForms }
> = {
	solve: {
		zh: { withObject: '求解 {obj} 的正根', withoutObject: '求解方程的正根' },
		en: {
			withObject: 'Solve for the positive roots of {obj}',
			withoutObject: 'Solve for the positive roots'
		}
	},
	simplify: {
		zh: { withObject: '化简 {obj}', withoutObject: '化简表达式' },
		en: { withObject: 'Simplify {obj}', withoutObject: 'Simplify the expression' }
	},
	factor: {
		zh: { withObject: '分解 {obj}', withoutObject: '因式分解' },
		en: { withObject: 'Factor {obj}', withoutObject: 'Factor the expression' }
	},
	evaluate: {
		zh: { withObject: '代入求 {obj}', withoutObject: '代入求值' },
		en: { withObject: 'Substitute and evaluate {obj}', withoutObject: 'Substitute and evaluate' }
	},
	sign: {
		zh: { withObject: '验证 {obj} 的符号', withoutObject: '比较不等式' },
		en: { withObject: 'Check the sign of {obj}', withoutObject: 'Compare the inequality' }
	},
	narrow: {
		zh: { withObject: '数值逼近 {obj} 的根', withoutObject: '缩小根的范围' },
		en: {
			withObject: 'Narrow the root of {obj} numerically',
			withoutObject: "Narrow the root's range"
		}
	},
	derive: {
		zh: { withObject: '推导中间表达式', withoutObject: '推导中间表达式' },
		en: {
			withObject: 'Deriving intermediate expressions',
			withoutObject: 'Deriving intermediate expressions'
		}
	}
};

/**
 * A transform names a different verb per word: differentiate, integrate, or the
 * generic transform. Choosing by the earliest signal keeps "integral of the
 * derivative" on the integral it opens with.
 */
const TITLE_TEMPLATE_TRANSFORM_FORMS: Record<
	'derivative' | 'integral' | 'transform',
	{ zh: TitleTemplateForms; en: TitleTemplateForms }
> = {
	derivative: {
		zh: { withObject: '对 {obj} 求导', withoutObject: '求导计算' },
		en: {
			withObject: 'Differentiate {obj}',
			withoutObject: 'Differentiate the expression'
		}
	},
	integral: {
		zh: { withObject: '对 {obj} 积分', withoutObject: '积分计算' },
		en: { withObject: 'Integrate {obj}', withoutObject: 'Integrate the expression' }
	},
	transform: {
		zh: { withObject: '变换 {obj}', withoutObject: '变换表达式' },
		en: { withObject: 'Transform {obj}', withoutObject: 'Transform the expression' }
	}
};

const TITLE_TEMPLATE_DERIVATIVE_RE = /\bderivatives?\b|\bdifferentiat|求导|导数|微分/iu;
const TITLE_TEMPLATE_INTEGRAL_RE = /\bintegrals?\b|\bintegrat|积分/iu;

/** A function-shaped symbol: `H(t)`, `F(k)`, `A(0)`. */
const TITLE_TEMPLATE_FUNCTION_OBJECT_RE =
	/(?<![\p{L}\p{N}_])([A-Za-z])\s*\(\s*([A-Za-z]\d*|\d+)\s*\)/gu;

/** A bare symbol: `k`, `Q4`, `σ1`. */
const TITLE_TEMPLATE_SYMBOL_RE = /(?<![\p{L}\p{N}_])([A-Za-zσλμθφ]\d*)(?![\p{L}\p{N}_])/gu;

/** Letters that are English words before they are symbols. */
const TITLE_TEMPLATE_NON_SYMBOLS = new Set(['a', 'A', 'i', 'I']);

function templateSpeaksChinese(text: string): boolean {
	let cjk = 0;
	let visible = 0;
	for (const char of text) {
		if (/\s/u.test(char)) {
			continue;
		}
		visible++;
		if (CJK_RUN_RE.test(char)) {
			cjk++;
		}
	}
	return visible > 0 && cjk / visible > TITLE_TEMPLATE_CJK_SHARE;
}

/**
 * The block's category: signals are counted (capped per signal) and the highest
 * total wins. Near-ties resolve by table order, and no signal at all falls back
 * to `derive`: a dense block still names the work it does.
 */
function templateCategoryFor(text: string): {
	category: TitleTemplateCategory;
	verb?: 'derivative' | 'integral' | 'transform';
} {
	const scores = new Map<TitleTemplateCategory, number>();
	for (const { category, pattern, weight } of TITLE_TEMPLATE_SIGNALS) {
		let matches = 0;
		for (const _ of text.matchAll(pattern)) {
			matches++;
			if (matches >= TITLE_TEMPLATE_SIGNAL_MATCH_CAP) {
				break;
			}
		}
		if (matches) {
			scores.set(category, (scores.get(category) ?? 0) + weight * matches);
		}
	}

	let best: TitleTemplateCategory = 'derive';
	let bestScore = 0;
	for (const category of TITLE_TEMPLATE_CATEGORY_ORDER) {
		const score = scores.get(category) ?? 0;
		// Near-equal scores are a tie, so the earlier category in the table keeps
		// the win; a clear lead replaces it.
		if (score > bestScore + TITLE_TEMPLATE_TIE_MARGIN) {
			best = category;
			bestScore = score;
		}
	}
	if (bestScore < TITLE_TEMPLATE_MIN_SIGNAL) {
		return { category: 'derive' };
	}
	if (best !== 'transform') {
		return { category: best };
	}

	const derivativeAt = text.search(TITLE_TEMPLATE_DERIVATIVE_RE);
	const integralAt = text.search(TITLE_TEMPLATE_INTEGRAL_RE);
	if (derivativeAt !== -1 && (integralAt === -1 || derivativeAt <= integralAt)) {
		return { category: 'transform', verb: 'derivative' };
	}
	if (integralAt !== -1) {
		return { category: 'transform', verb: 'integral' };
	}
	return { category: 'transform', verb: 'transform' };
}

/** A symbol is usable as an object only if it stays a symbol. */
function templateObjectIsUsable(object: string): boolean {
	const stripped = object.replace(/^["'“”‘’]+|["'“”‘’]+$/gu, '').trim();
	return (
		!!stripped &&
		Array.from(stripped).length <= TITLE_TEMPLATE_OBJECT_MAX_LENGTH &&
		!/[=\s]/u.test(stripped)
	);
}

/**
 * The object the block's formulas act on. The first function-shaped symbol is
 * the block's own LHS ("H(t) = …"); without one, the most frequent bare symbol
 * stands in ("Q4", "k"). A letter that is an English word is never a symbol.
 */
function templateObjectFor(text: string): string | null {
	for (const match of text.matchAll(TITLE_TEMPLATE_FUNCTION_OBJECT_RE)) {
		const object = `${match[1]}(${match[2]})`;
		if (templateObjectIsUsable(object)) {
			return object;
		}
	}

	const counts = new Map<string, { count: number; first: number }>();
	for (const match of text.matchAll(TITLE_TEMPLATE_SYMBOL_RE)) {
		const symbol = match[1];
		if (TITLE_TEMPLATE_NON_SYMBOLS.has(symbol)) {
			continue;
		}
		const existing = counts.get(symbol);
		if (existing) {
			existing.count++;
		} else {
			counts.set(symbol, { count: 1, first: match.index ?? 0 });
		}
	}

	let best: string | null = null;
	let bestCount = TITLE_TEMPLATE_OBJECT_MIN_COUNT - 1;
	let bestFirst = Number.POSITIVE_INFINITY;
	for (const [symbol, { count, first }] of counts) {
		if (count > bestCount || (count === bestCount && first < bestFirst)) {
			best = symbol;
			bestCount = count;
			bestFirst = first;
		}
	}
	return best && templateObjectIsUsable(best) ? best : null;
}

/** The composed title for a formula-dense block, or null when it cannot form one. */
function templateTitleFor(blockText: string): string | null {
	const { category, verb } = templateCategoryFor(blockText);
	const forms =
		category === 'transform'
			? TITLE_TEMPLATE_TRANSFORM_FORMS[verb ?? 'transform']
			: TITLE_TEMPLATE_FORMS[category];
	const language = templateSpeaksChinese(blockText) ? 'zh' : 'en';
	const object = category === 'derive' ? null : templateObjectFor(blockText);
	const form = language === 'zh' ? forms.zh : forms.en;
	const title = object ? form.withObject.replace('{obj}', object) : form.withoutObject;
	if (
		Array.from(title).length < TITLE_MIN_CHARS ||
		displayWidth(title) > REASONING_SUMMARY_TITLE_MAX_WIDTH
	) {
		return null;
	}
	return title;
}

/**
 * Template candidates for a block, at most one. The block must be prose
 * (structural shapes return before the pool is collected) and formula dense: at
 * least half of its sentences carry a formula mark. Both tests reuse existing
 * signals, so the layer adds one O(block) pass and no tokenizer.
 */
function collectTemplateCandidates(
	blockText: string,
	sentences: readonly SentenceSpan[],
	sentenceCount: number,
	centrality: readonly number[],
	contentIdf: ContentIdf
): EnhancedCandidate[] {
	if (sentences.length < TITLE_TEMPLATE_MIN_SENTENCES) {
		return [];
	}

	const firstLine = blockText.split('\n', 1)[0].trim();
	if (LIST_ITEM_RE.test(firstLine) || /^(?:```|~~~)/u.test(firstLine) || /^\|/u.test(firstLine)) {
		return [];
	}

	const formulaSentences = sentences.filter((sentence) => formulaMarks(sentence.text) > 0).length;
	if (formulaSentences / sentences.length < TITLE_TEMPLATE_FORMULA_SENTENCE_SHARE) {
		return [];
	}

	const title = templateTitleFor(blockText);
	if (!title) {
		return [];
	}

	// The template names the whole block, so it consumes nothing: the body keeps
	// the original lines, like a definition title.
	const candidate = enhanceCandidate(
		{ title, consumed: 0, abridged: true },
		'template',
		0,
		false,
		sentenceCount,
		centrality,
		contentIdf
	);
	return candidate ? [candidate] : [];
}

// The candidate pool. Every sentence, clause prefix, long quote and label task
// enters; none is pre-filtered for being a beat — position only labels a
// candidate, the score decides. Structural titles return before this pass.
//
// One collector per family, dispatched in table order: an earlier family wins a
// tie against a later one with the same score, so the order is behaviour.
type TitlePool = {
	text: string;
	sentenceCount: number;
	centrality: readonly number[];
	contentIdf: ContentIdf;
	continuation: boolean;
	priorTitleTerms: ReadonlySet<string>;
	byTitle: Map<string, EnhancedCandidate>;
	/** Ordinary-layer synthesis attempts, capped across the whole block. */
	synthesisAttempts: number;
};

type SentenceSlot = {
	index: number;
	sentence: SentenceSpan;
	/** The position prior this sentence's own prose competes under. */
	source: TitleSource;
	markup: boolean;
};

type AddCandidate = (
	candidate: TitleCandidate & { compressed?: boolean },
	kind: TitleSource,
	rawStart?: number,
	rawEnd?: number
) => void;

type TitleCollector = (pool: TitlePool, slot: SentenceSlot, add: AddCandidate) => void;

/** Lines that are structure (empty, list, fence, table) never enter the pool. */
function isStructuralTitleLine(line: string): boolean {
	return !line || LIST_ITEM_RE.test(line) || /^(?:```|~~~)/u.test(line) || /^\|/u.test(line);
}

function keepTitleCandidate(
	byTitle: Map<string, EnhancedCandidate>,
	candidate: EnhancedCandidate | null
): void {
	if (!candidate) {
		return;
	}
	const key = candidate.title.toLowerCase();
	const existing = byTitle.get(key);
	if (!existing || candidate.score > existing.score) {
		byTitle.set(key, candidate);
	}
}

/** Score and file one candidate against the sentence that produced it. */
function titleCandidateAdder(pool: TitlePool, slot: SentenceSlot): AddCandidate {
	return (candidate, kind, rawStart = slot.sentence.start, rawEnd = slot.sentence.end) => {
		const continuationBonus = pool.continuation
			? titleContinuationBonus(
					candidate.title,
					pool.text.slice(rawStart, rawEnd),
					pool.priorTitleTerms
				)
			: 0;
		keepTitleCandidate(
			pool.byTitle,
			enhanceCandidate(
				candidate,
				kind,
				slot.index,
				slot.markup,
				pool.sentenceCount,
				pool.centrality,
				pool.contentIdf,
				candidateMergeFlags(pool.text, rawStart, rawEnd, candidate.consumed),
				continuationBonus
			)
		);
	};
}

// The block's lead is its first sentence that says something. A marker like
// "嗯，" is a sentence of its own in the split, but the task behind it is the
// opening lead.
function findLeadSentenceIndex(sentences: readonly SentenceSpan[]): number {
	return sentences.findIndex((sentence) => {
		const trimmed = sentence.text.trim();
		return !isStructuralTitleLine(trimmed) && !isDiscourseMarkerOnly(trimmed);
	});
}

// A sequencing word with a comma in front of the intent ("First, let me find…")
// still states intent; "First I'll parse…" is a later sentence and stays one, so
// the lead marker has to be separated.
function titleSourceFor(trimmed: string, index: number, leadIndex: number): TitleSource {
	const intent =
		TOPIC_INTENT_RE.test(trimmed) ||
		TOPIC_INTENT_RE.test(
			trimmed.replace(/^(?:first|firstly|second|secondly|finally)\s*[,，:]\s*/iu, '')
		);
	const asker = !intent && TOPIC_ASKER_RE.test(trimmed);
	return intent
		? 'intent'
		: index === leadIndex
			? 'opening'
			: asker
				? 'asker'
				: index === 1 && SECOND_SENTENCE_OPENER_RE.test(trimmed)
					? 'second'
					: 'later';
}

function collectQuoteTitle(pool: TitlePool, slot: SentenceSlot, add: AddCandidate): void {
	const quote = findLongQuotedSpan(slot.sentence.text);
	const quoteTitle = quote ? quotedTitle(quote.text) : null;
	if (!quoteTitle) {
		return;
	}
	// The quote is the title, not the label colon in front of it: an empty raw
	// span keeps the merge penalties off it.
	add(
		{ title: quoteTitle, consumed: slot.sentence.end, abridged: true },
		'quote',
		slot.sentence.end,
		slot.sentence.end
	);
}

function collectProseTitles(pool: TitlePool, slot: SentenceSlot, add: AddCandidate): void {
	const main = deriveProseCandidate(pool.text, slot.sentence.start, true, slot.sentence.end);
	if (main) {
		add(main, slot.source);
	}
	const verbatim = deriveVerbatimCandidate(pool.text, slot.sentence.start, slot.sentence.end);
	if (verbatim) {
		add(verbatim, slot.source);
	}
}

// A verb phrase composed from the block's lead or a stated task competes like any
// other candidate; its lower position prior and synthesis penalty keep it behind
// the block's own words unless it reads clearly better. A later beat is not
// synthesized: its verb+object is usually a step of the reasoning, not the
// block's topic.
function collectSynthesisTitle(pool: TitlePool, slot: SentenceSlot, add: AddCandidate): void {
	if (slot.source !== 'opening' && slot.source !== 'intent' && slot.source !== 'asker') {
		return;
	}
	if (pool.synthesisAttempts >= TITLE_SYNTHESIS_ATTEMPT_LIMIT) {
		return;
	}
	pool.synthesisAttempts++;
	const synthesized = deriveSynthesizedCandidate(pool.text, slot.sentence.start, slot.sentence.end);
	if (synthesized) {
		add(synthesized, 'synthesis');
	}
}

function collectClauseTitles(pool: TitlePool, slot: SentenceSlot, add: AddCandidate): void {
	const clauseSource: TitleSource = slot.index === 0 ? 'opening-clause' : 'clause';
	const breakEnds = findClauseBreakEnds(pool.text, slot.sentence.start, slot.sentence.end).slice(
		0,
		TITLE_CLAUSE_CANDIDATE_LIMIT
	);
	for (const breakEnd of breakEnds) {
		const prefix = deriveProseCandidate(pool.text, slot.sentence.start, true, breakEnd);
		if (prefix) {
			add(prefix, clauseSource, slot.sentence.start, breakEnd);
		}
		const prefixVerbatim = deriveVerbatimCandidate(pool.text, slot.sentence.start, breakEnd);
		if (prefixVerbatim) {
			add(prefixVerbatim, clauseSource, slot.sentence.start, breakEnd);
		}
	}
}

function collectTaskTitles(pool: TitlePool, slot: SentenceSlot, add: AddCandidate): void {
	for (const taskStart of findLabelTaskStarts(pool.text, slot.sentence.start, slot.sentence.end)) {
		const taskEnd =
			findClauseBreakEnds(pool.text, taskStart, slot.sentence.end)[0] ?? slot.sentence.end;
		// A label in front of a list leaves the list to the body: the first item
		// is a candidate only through the list's own prose, not through its
		// marker ("1. The output marked").
		if (LIST_ITEM_RE.test(pool.text.slice(taskStart, taskEnd).trim())) {
			continue;
		}
		const task = deriveProseCandidate(pool.text, taskStart, true, taskEnd);
		if (task) {
			add(task, 'task', taskStart, taskEnd);
		}
	}
}

// The fix-up source: the first later sentence that reads as a topic sentence. It
// enters with the lowest position prior, so it only titles when nothing better
// survives.
function collectFixupTitle(pool: TitlePool, sentences: readonly SentenceSpan[]): void {
	const chinese = CJK_RUN_RE.test(pool.text);
	for (let index = 1; index < sentences.length; index++) {
		const sentence = sentences[index];
		if (chinese && !CJK_RUN_RE.test(sentence.text)) {
			continue;
		}
		if (!sentenceEnds(sentence.text)) {
			continue;
		}
		const trimmed = sentence.text.trim();
		if (LIST_ITEM_RE.test(trimmed) || /^\s*(?:```|~~~)/u.test(sentence.text)) {
			continue;
		}
		// The fix-up slot is the last resort: a sentence that opens on a topic
		// skip word is not promoted to it. The same sentence already entered the
		// pool from the main loop as a later/opening candidate, so the fallback
		// layer can still choose it without this pass.
		if (TOPIC_SENTENCE_SKIP_RE.test(sentence.text) && !findLongQuotedSpan(sentence.text)) {
			continue;
		}
		const fixup = deriveProseCandidate(pool.text, sentence.start, true, sentence.end);
		if (!fixup) {
			continue;
		}
		const slot: SentenceSlot = {
			index,
			sentence,
			source: 'fixup',
			markup: TITLE_MARKUP_START_RE.test(trimmed)
		};
		titleCandidateAdder(pool, slot)(fixup, 'fixup');
		break;
	}
}

const TITLE_COLLECTORS: readonly TitleCollector[] = [
	collectQuoteTitle,
	collectProseTitles,
	collectSynthesisTitle,
	collectClauseTitles,
	collectTaskTitles
];

function collectTitleCandidates(
	text: string,
	blockText: string,
	contentIdf: ContentIdf,
	priorTitleTerms: ReadonlySet<string> = EMPTY_TITLE_TERMS
): EnhancedCandidate[] {
	// Sentences split on the block as written, so a newline stays a boundary and
	// a list item cannot swallow the prose after it.
	const sentences = splitSentences(blockText);
	const sentenceCount = sentences.length;
	// Centrality is masked to sentences that read as topics: a repeated beat or
	// a fragment can be the graph's centre without being a title.
	const centrality = sentenceCentrality(blockText, sentences).map((value, index) =>
		isCentralSentence(sentences[index].text) ? value : 0
	);
	const pool: TitlePool = {
		text,
		sentenceCount,
		centrality,
		contentIdf,
		// The anchor is block-level: it only asks whether this block's lead
		// continues the previous one. Detecting it once keeps the per-candidate
		// work to two set intersections.
		continuation: priorTitleTerms.size > 0 && opensWithContinuation(blockText),
		priorTitleTerms,
		byTitle: new Map<string, EnhancedCandidate>(),
		synthesisAttempts: 0
	};
	const leadIndex = findLeadSentenceIndex(sentences);

	for (let index = 0; index < sentences.length; index++) {
		const sentence = sentences[index];
		const trimmed = sentence.text.trim();
		if (isStructuralTitleLine(trimmed)) {
			continue;
		}
		const slot: SentenceSlot = {
			index,
			sentence,
			source: titleSourceFor(trimmed, index, leadIndex),
			markup: TITLE_MARKUP_START_RE.test(trimmed)
		};
		const add = titleCandidateAdder(pool, slot);
		for (const collect of TITLE_COLLECTORS) {
			collect(pool, slot, add);
		}
	}

	collectFixupTitle(pool, sentences);

	// A formula-dense block's own sentences are all calculation fragments. The
	// template layer is tried by the fallback pass below, which is the only
	// layer that may take it; the ordinary pool never uses one, so building it
	// here would cost every well-titled block for nothing.

	return [...pool.byTitle.values()];
}

// ---------------------------------------------------------------------------
// Definition titles (fallback layer)
//
// "Define A(k) = k² − 376k − 5120 (the negative branch…)" names the block, but
// it is neither an opening lead nor an intent, and its direct candidate carries
// the formula tail. The fallback composes the verb with the defined symbol
// only: the assignment and everything behind it never enter the title.
// ---------------------------------------------------------------------------

const DEFINITION_EN_VERB_RE = /^(Define|Let|Set|Denote)\b\s*/iu;
const DEFINITION_ZH_VERB_RE = /^(定义|设|令|记)\s*/u;
const DEFINITION_OBJECT_RE = /^[\p{L}][\p{L}\p{N}_]*(?:\s*\([^()=]{0,20}\))?$/u;

// Pronouns a "Let …" sentence can start with but a definition cannot define.
const DEFINITION_PRONOUNS = new Set([
	'me',
	'us',
	'this',
	'that',
	'it',
	'there',
	'them',
	'him',
	'her',
	'you',
	'we',
	'i'
]);

type DefinitionSeparator = { text: string; spaced: boolean };

const DEFINITION_EN_SEPARATORS: ReadonlyArray<DefinitionSeparator> = [
	{ text: '=', spaced: false },
	{ text: ':=', spaced: false },
	{ text: 'by', spaced: true },
	{ text: 'be', spaced: true },
	{ text: 'as', spaced: true },
	{ text: ',', spaced: false },
	{ text: ';', spaced: false },
	{ text: ':', spaced: false },
	{ text: '.', spaced: false }
];

const DEFINITION_ZH_SEPARATORS: ReadonlyArray<DefinitionSeparator> = [
	'=',
	'＝',
	'为',
	'是',
	'表示',
	'，',
	',',
	'。',
	'；',
	';',
	'：',
	':'
].map((text) => ({ text, spaced: false }));

// The smallest index at which a separator starts, or the end of the text. A
// spaced connector is matched with its spaces, so "be" cannot fire inside
// "beta"; an unspaced one is a symbol, a bracket or sentence punctuation.
function definitionSeparatorIndex(
	rest: string,
	separators: ReadonlyArray<DefinitionSeparator>
): number {
	let best = rest.length;
	for (const { text, spaced } of separators) {
		const at = rest.indexOf(spaced ? ` ${text} ` : text);
		if (at !== -1 && at < best) {
			best = at;
		}
	}
	return best;
}

/**
 * The title a definition sentence carries, or null. Only the verb and its symbol
 * survive: "Define A(k) = …", "Let f(x) be …", "设 F(k) = …". The symbol must be
 * a compact name (letters, digits, one parenthesised argument list), so "Let (t²
 * + at + b)(…) = …" is not a definition title.
 */
function definitionTitle(source: string): string | null {
	const trimmed = source.trim();
	const verb = DEFINITION_EN_VERB_RE.exec(trimmed);
	if (verb) {
		const rest = trimmed.slice(verb[0].length);
		const object = rest.slice(0, definitionSeparatorIndex(rest, DEFINITION_EN_SEPARATORS)).trim();
		if (!definitionObjectIsUsable(object) || DEFINITION_PRONOUNS.has(object.toLowerCase())) {
			return null;
		}
		return normalizeTitleSpacing(`${verb[1]} ${object}`);
	}

	const chinese = DEFINITION_ZH_VERB_RE.exec(trimmed);
	if (!chinese) {
		return null;
	}
	const rest = trimmed.slice(chinese[0].length);
	const object = rest.slice(0, definitionSeparatorIndex(rest, DEFINITION_ZH_SEPARATORS)).trim();
	if (!definitionObjectIsUsable(object)) {
		return null;
	}
	return normalizeTitleSpacing(`${chinese[1]} ${object}`);
}

function definitionObjectIsUsable(object: string): boolean {
	return (
		Array.from(object).length >= TITLE_MIN_CHARS &&
		displayWidth(object) <= 24 &&
		DEFINITION_OBJECT_RE.test(object)
	);
}

// Definition candidates join the fallback pool only: the ordinary layer keeps
// its opening/intent/asker synthesis unchanged.
function collectDefinitionCandidates(
	blockText: string,
	sentences: readonly SentenceSpan[],
	contentIdf: ContentIdf
): EnhancedCandidate[] {
	if (!sentences.length) {
		return [];
	}

	const centrality = sentenceCentrality(blockText, sentences);
	const keep = new Map<string, EnhancedCandidate>();
	for (let index = 0; index < sentences.length; index++) {
		const sentence = sentences[index];
		const title = definitionTitle(sentence.text);
		if (!title) {
			continue;
		}
		const candidate = enhanceCandidate(
			{ title, consumed: sentence.end, abridged: true },
			'definition',
			index,
			false,
			sentences.length,
			centrality,
			contentIdf,
			{ labelMerge: false, listMerge: false, codeLabel: false },
			0
		);
		if (!candidate) {
			continue;
		}
		const key = candidate.title.toLowerCase();
		const existing = keep.get(key);
		if (!existing || candidate.score > existing.score) {
			keep.set(key, candidate);
		}
	}
	return [...keep.values()];
}

// A fallback title still has to be a phrase: the hard rejections are the same
// ones the ordinary layer enforces by scoring, but they are checked here because
// a discounted penalty could otherwise lift a fragment over the fallback floor.
function isFallbackTitleAllowed(candidate: EnhancedCandidate): boolean {
	const title = candidate.title.trim();
	if (!title || Array.from(title).length < TITLE_MIN_CHARS) {
		return false;
	}
	// A bare number or punctuation run is not a phrase.
	if (!/\p{L}/u.test(title)) {
		return false;
	}
	if (isDiscourseMarkerOnly(title) || isCodeLikeTitle(title)) {
		return false;
	}
	if (TITLE_FALLBACK_ASIDE_RE.test(title)) {
		return false;
	}
	if (TITLE_FALLBACK_FORMULA_STATEMENT_RE.test(title)) {
		return false;
	}
	// A definition was validated when it was composed: its object is a symbol,
	// not a content word, so it is the one phrase exempt from the word counts.
	if (candidate.source === 'definition') {
		return true;
	}
	// A template is composed from a closed table and shaped at composition, and
	// its object can be a symbol ("Simplify H(t)"): it is a phrase by
	// construction, so the word counts do not apply to it either.
	if (candidate.source === 'template') {
		return true;
	}
	if (isWeakLabelTitle(title)) {
		return false;
	}
	return CJK_RUN_RE.test(title) || title.split(/\s+/u).filter(Boolean).length >= 2;
}

// Whether a pool candidate may title the block at all: above the floor, and not
// a lone intent/synthesis sentence that only says what the block is about to do.
function isTitlingCandidate(candidate: EnhancedCandidate, text: string, fallback = false): boolean {
	if (candidate.score < (fallback ? TITLE_SCORE_FLOOR_FALLBACK : TITLE_SCORE_FLOOR)) {
		return false;
	}
	if (fallback && !isFallbackTitleAllowed(candidate)) {
		return false;
	}
	return !(
		(candidate.source === 'intent' || candidate.source === 'synthesis') &&
		candidate.sentence === 0 &&
		candidate.consumed >= text.trimEnd().length
	);
}

// The winning candidate: the highest adjusted score above the floor. The floor
// and the lone-intent rule read the base score, so diversity never decides
// whether a block has a title. Ties keep the earlier candidate.
function chooseBestCandidate(
	candidates: EnhancedCandidate[],
	text: string,
	chosenTitles: readonly TitleBag[] = [],
	margin = 0,
	fallback = false
): TitleCandidate {
	// A template speaks only in the fallback layer, and only when the natural
	// pool is silent: it is the block's last voice, not a competitor. The prior
	// alone cannot promise that (a clean template phrase collects enough
	// specificity to pass a marginal natural one), so eligibility is explicit —
	// the same kind of rule as the lone-intent test below. The ordinary layer
	// never takes a template: a natural opening wins even just above the floor.
	const naturalTitles = candidates.some(
		(candidate) =>
			candidate.source !== 'template' &&
			// A discourse marker is not a title: the final pass drops it, so it
			// must not keep the template out either.
			!isDiscourseMarkerOnly(candidate.title) &&
			isTitlingCandidate(candidate, text, fallback)
	);
	const pool = fallback
		? candidates.filter((candidate) => !(naturalTitles && candidate.source === 'template'))
		: candidates.filter((candidate) => candidate.source !== 'template');

	let baseBest: EnhancedCandidate | null = null;
	let diverseBest: EnhancedCandidate | null = null;
	let diverseBestAdjusted = Number.NEGATIVE_INFINITY;
	let baseBestAdjusted = Number.NEGATIVE_INFINITY;
	for (const candidate of pool) {
		if (!isTitlingCandidate(candidate, text, fallback)) {
			continue;
		}
		const terms = new Set(titleContentWordTerms(candidate.title));
		const adjusted =
			candidate.score - titleDiversityPenalty(terms, Math.sqrt(terms.size), chosenTitles);
		if (!baseBest || candidate.score > baseBest.score) {
			baseBest = candidate;
			baseBestAdjusted = adjusted;
		}
		if (!diverseBest || adjusted > diverseBestAdjusted) {
			diverseBest = candidate;
			diverseBestAdjusted = adjusted;
		}
	}

	// The floor and the lone-intent rule read the base score, so the diversity
	// penalty never makes a block titleless. A replacement must win by the margin.
	const winner =
		diverseBest &&
		baseBest &&
		diverseBest !== baseBest &&
		diverseBestAdjusted > baseBestAdjusted + margin
			? diverseBest
			: baseBest;

	return winner
		? { title: winner.title, consumed: winner.consumed, abridged: winner.abridged }
		: NO_TITLE;
}

type OpeningLine = {
	/** Index of the first non-space character. */
	start: number;
	/** Index of the newline that ends the line, or the block length. */
	end: number;
	text: string;
};

// The line that carries the block's structure. A horizontal rule can open the
// block ("---" before a heading): the line that carries the structure is the
// next one.
function findOpeningLine(blockText: string): OpeningLine {
	let start = 0;
	let end = blockText.indexOf('\n');
	if (end === -1) {
		end = blockText.length;
	}

	if (/^[-*_=]{3,}\s*$/.test(blockText.slice(start, end).trim()) && end < blockText.length) {
		start = end + 1;
		const nextEnd = blockText.indexOf('\n', start);
		end = nextEnd === -1 ? blockText.length : nextEnd;
	}

	const raw = blockText.slice(start, end);
	return {
		start: start + (raw.length - raw.trimStart().length),
		end,
		text: raw.trim()
	};
}

// A plain list item can be prose with a lead ("2. The JS itself: …"). Its own
// lead titles the block, while the item stays in the body as written.
function deriveListItemTitle(
	text: string,
	lineStart: number,
	firstLine: string
): TitleCandidate | null {
	const marker = /^(?:[-*+]|\d+[.)])\s+/.exec(firstLine);
	if (!marker) {
		return null;
	}

	const source = text.slice(lineStart + marker[0].length);
	if (/^\[[ xX]\]\s+/.test(source)) {
		return null;
	}

	const quote = findLongQuotedSpan(source.slice(0, cutTitleAtPunctuation(source).consumed));
	if (quote) {
		const title = quotedTitle(quote.text);
		if (title) {
			return { title, consumed: 0, abridged: true };
		}
	}

	const candidate = deriveProseCandidate(source, 0);
	if (!candidate || !isTopicTitle(candidate.title) || isWeakLabelTitle(candidate.title)) {
		return null;
	}

	return { title: candidate.title, consumed: 0, abridged: true };
}

/**
 * A title and the pool it was chosen from. The pool is empty for a structural
 * title, which is right by construction and never re-chosen for diversity.
 */
type TitleSelection = {
	candidate: TitleCandidate;
	candidates: EnhancedCandidate[];
	/**
	 * The block went through the prose pool. A structural block (a fence, a
	 * list, a table) keeps its own rendering rule; only prose blocks may join a
	 * previous summary when they stay titleless.
	 */
	prose?: boolean;
	/** The candidate and pool came from the fallback layer. */
	fallback?: boolean;
};

const NO_TITLE_SELECTION: TitleSelection = { candidate: NO_TITLE, candidates: [] };

function structuralSelection(candidate: TitleCandidate): TitleSelection {
	return { candidate, candidates: [] };
}

function findTitleCandidate(
	blockText: string,
	contentIdf: ContentIdf,
	context: TitleContext = { chosenTitles: [], priorTitleTerms: EMPTY_TITLE_TERMS }
): TitleSelection {
	// The whole block reads as one line first: a quote or label spanning two lines
	// is one span. Newlines become single spaces, so every offset still points
	// into the original block.
	const text = blockText.replace(/\n/g, ' ');

	// Structure, though, lives on the original opening line — a heading, a list
	// item or a table row only means something on the line it was written on.
	const { start: lineStart, end: lineEnd, text: firstLine } = findOpeningLine(blockText);

	// Structure lives on the opening line: carving a title out of a list item, a
	// fence or a table row would corrupt the markdown, so those blocks render
	// titleless. A bold label inside a list item is the exception — it titles the
	// block while the body keeps the item as written.
	if (LIST_ITEM_RE.test(firstLine) || /^(?:```|~~~)/.test(firstLine)) {
		const boldItem = /^(?:[-*+]|\d+[.)])\s+(?:\*\*|__)(.+?)(?:\*\*|__)/.exec(firstLine);
		if (boldItem && !/[.!?。！？]$/.test(boldItem[1].trim())) {
			const start = lineStart + boldItem[0].indexOf(boldItem[1]);
			const label = carveTitle(text, start, start + boldItem[1].length, lineEnd);
			if (isUsableLabelTitle(label.title)) {
				return structuralSelection({ title: label.title, consumed: 0, abridged: true });
			}
		}
		// A plain item that is only a label ("3. Different aspects of
		// consciousness:") names its block the way a heading does. The item
		// stays in the body; the title is the label without its marker and
		// colon.
		const plainItem = /^(?:[-*+]|\d+[.)])\s+([^:*_`]+?)[：:]\s*$/.exec(firstLine);
		if (plainItem) {
			const labelText = plainItem[1].trim();
			const start =
				lineStart +
				plainItem[0].indexOf(plainItem[1]) +
				(plainItem[1].length - plainItem[1].trimStart().length);
			const label = carveTitle(text, start, start + labelText.length, lineEnd);
			if (displayWidth(labelText) <= 60 && isUsableLabelTitle(label.title)) {
				return structuralSelection({ title: label.title, consumed: 0, abridged: true });
			}
		}

		// A plain item can still be prose with a lead of its own, even when it
		// does not end in a label colon.
		if (!plainItem) {
			const itemTitle = deriveListItemTitle(text, lineStart, firstLine);
			if (itemTitle) {
				return structuralSelection(itemTitle);
			}
		}
		return NO_TITLE_SELECTION;
	}

	const secondLine = blockText
		.slice(lineEnd + 1)
		.split('\n', 1)[0]
		.trim();
	if (firstLine.includes('|') && isTableDelimiter(secondLine)) {
		return NO_TITLE_SELECTION;
	}

	const cut = cutTitleAtPunctuation(text);

	// A long quote in the lead is what the block is about, not the framing around
	// it. The search stops where the plain lead ends, so a stray pair deeper in
	// the block (a code snippet) cannot swallow whole lines.
	const quote = findLongQuotedSpan(text.slice(0, cut.consumed));
	const quoteTitle = quote ? quotedTitle(quote.text) : null;
	if (quote && quoteTitle) {
		// Swallow the separator between the quote and the body, the way a bold
		// `**Label:** rest` lead does.
		const separator = /^\s*[:：,，、;；.。!！?？]/.exec(text.slice(quote.end));
		const consumed = quote.end + (separator?.[0].length ?? 0);
		// The quote alone is lifted out of its sentence, so the body keeps that
		// sentence in its original form.
		return structuralSelection({ title: quoteTitle, consumed, abridged: true });
	}

	// Explicit heading.
	const heading = /^#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(firstLine);
	if (heading) {
		const start = lineStart + heading[0].indexOf(heading[1]);
		return structuralSelection(carveTitle(text, start, start + heading[1].length, lineEnd));
	}

	// A line that is entirely bold, or a bold lead-in such as `**Label:** rest`.
	const boldLine = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*$/.exec(firstLine);
	if (boldLine) {
		const start = lineStart + boldLine[0].indexOf(boldLine[1]);
		return structuralSelection(carveTitle(text, start, start + boldLine[1].length, lineEnd));
	}

	const boldLead = /^(?:\*\*|__)(.+?)(?:\*\*|__)\s*[:：,，、;；]?\s*/.exec(firstLine);
	if (boldLead) {
		const start = lineStart + boldLead[0].indexOf(boldLead[1]);
		return structuralSelection(
			carveTitle(text, start, start + boldLead[1].length, lineStart + boldLead[0].length)
		);
	}

	// A prose line ending in a colon whose next line is a list is a label: the
	// line itself titles and the list stays in the body.
	const labelText = firstLine.slice(0, -1).trimEnd();
	if (
		/[：:]\s*$/.test(firstLine) &&
		!/[.!?。！？]/u.test(labelText) &&
		LIST_ITEM_RE.test(secondLine)
	) {
		// A label that only names the shape of the answer ("The problem
		// requires:", "总结一下：") leaves the topic to its first item.
		if (META_LABEL_RE.test(labelText.trim())) {
			const itemTitle = deriveListLeadTitle(blockText, lineEnd);
			if (itemTitle) {
				return structuralSelection(itemTitle);
			}
		}
		const label = carveTitle(text, lineStart, lineStart + firstLine.length - 1, lineEnd, true);
		return isWeakLabelTitle(label.title) ? NO_TITLE_SELECTION : structuralSelection(label);
	}
	// A colon that directly introduces a dash list ("Steps: - fetch - parse")
	// behaves the same way.
	const inlineColon = /[：:]\s+(?=[-–—]\s)/.exec(firstLine);
	if (inlineColon && !/[.!?。！？]/u.test(firstLine.slice(0, inlineColon.index))) {
		const colonEnd = lineStart + inlineColon.index + 1;
		const label = carveTitle(text, lineStart, lineStart + inlineColon.index, colonEnd, true);
		return isWeakLabelTitle(label.title) ? NO_TITLE_SELECTION : structuralSelection(label);
	}

	// Prose: every sentence, clause prefix, quote and label task enters the
	// pool; the highest adjusted score titles the block. A structural candidate
	// never reaches this pass — it was returned above.
	const candidates = collectTitleCandidates(text, blockText, contentIdf, context.priorTitleTerms);
	const candidate = chooseBestCandidate(
		candidates,
		text,
		context.chosenTitles,
		TITLE_DIVERSITY_MARGIN
	);
	if (candidate.title) {
		return { candidate, candidates, prose: true };
	}

	// No candidate cleared the ordinary floor. Re-score the pool just built under
	// the fallback layer (its score came with the ordinary one, so nothing is
	// collected twice), add the definitions the ordinary synthesis does not
	// reach, and compose the block's template if it is formula dense. A block
	// still without anything usable here renders titleless.
	const fallbackSentences = splitSentences(blockText);
	const fallbackPool = new Map<string, EnhancedCandidate>();
	for (const entry of [
		...candidates,
		...collectDefinitionCandidates(blockText, fallbackSentences, contentIdf),
		...collectTemplateCandidates(
			blockText,
			fallbackSentences,
			fallbackSentences.length,
			// A template is never a centrality source, so the masked sentence
			// graph is not computed for it.
			[],
			contentIdf
		)
	]) {
		entry.score = entry.fallbackScore;
		const key = entry.title.toLowerCase();
		const existing = fallbackPool.get(key);
		if (!existing || entry.score > existing.score) {
			fallbackPool.set(key, entry);
		}
	}
	const fallbackCandidates = [...fallbackPool.values()];
	return {
		candidate: chooseBestCandidate(
			fallbackCandidates,
			text,
			context.chosenTitles,
			TITLE_DIVERSITY_MARGIN,
			true
		),
		candidates: fallbackCandidates,
		prose: true,
		fallback: true
	};
}

// A title that says the whole block ("先看看问题。" -> "先看看问题") is not worth
// showing: the block already reads as its own title, so it renders without one.
function deriveReasoningSummaryTitle(
	text: string,
	contentIdf: ContentIdf = NEUTRAL_CONTENT_IDF,
	context: TitleContext = { chosenTitles: [], priorTitleTerms: EMPTY_TITLE_TERMS }
): TitleSelection {
	const selection = findTitleCandidate(text, contentIdf, context);
	const candidate = selection.candidate;
	// An abridged title keeps the original text as the body, so it titles a
	// block even when its topic sentence is the last one; a verbatim lead only
	// titles when something follows it.
	if (!candidate.title || (!candidate.abridged && !text.slice(candidate.consumed).trim())) {
		return {
			candidate: NO_TITLE,
			candidates: selection.candidates,
			prose: selection.prose,
			fallback: selection.fallback
		};
	}
	// A title that is only a beat ("Wait", "首先", "好的") names nothing: the
	// block reads better without a title line.
	if (isDiscourseMarkerOnly(candidate.title)) {
		return {
			candidate: NO_TITLE,
			candidates: selection.candidates,
			prose: selection.prose,
			fallback: selection.fallback
		};
	}
	return {
		candidate: { ...candidate, title: capitalizeTitleLead(candidate.title) },
		candidates: selection.candidates,
		prose: selection.prose,
		fallback: selection.fallback
	};
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

/**
 * Fenced code blocks while scanning lines. A cut inside a fence would break the
 * code, so every scanner asks the same tracker whether it is still inside one.
 */
class FenceState {
	private marker = '';

	get active(): boolean {
		return this.marker !== '';
	}

	/** Consume a trimmed line; returns true when the line is a fence marker. */
	consume(trimmedLine: string): boolean {
		const match = /^(```|~~~)/.exec(trimmedLine);
		if (!match) {
			return false;
		}

		if (!this.marker) {
			this.marker = match[1];
		} else if (trimmedLine.startsWith(this.marker)) {
			this.marker = '';
		}
		return true;
	}
}

// A block renders as its own Markdown instance, where a blank line would open a
// paragraph gap. Blank runs collapse; a fence keeps its blank lines.
function collapseBlankLines(lines: string[]): string[] {
	const fence = new FenceState();
	return lines.filter((line) => {
		const trimmed = line.trim();
		fence.consume(trimmed);
		return fence.active || trimmed !== '';
	});
}

// Removes fenced code blocks, fences included, from the body: the code would
// otherwise dominate the body's token budget.
function dropFencedCodeBlocks(text: string): string {
	const fence = new FenceState();
	return text
		.split('\n')
		.filter((line) => {
			if (fence.consume(line.trim())) {
				return false;
			}
			return !fence.active;
		})
		.join('\n');
}

/** Collapses blank lines and drops unpaired bold markers before a block renders. */
function prepareBlockText(lines: string[]): string {
	return stripUnpairedBoldMarkers(collapseBlankLines(lines).join('\n').trim());
}

// The body renders as plain text: markdown markers are removed and lines are
// joined, so a block reads as one line under its title. Fenced code is dropped
// whole before the token budget is applied.
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
			.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+\[[ xX]\]\s+/gm, '') // task-list markers
			.replace(/^\s*[-*+]\s+/gm, '') // bullet markers
			.replace(/^\s*\d{1,3}[.)]\s+/gm, '') // ordered-list markers
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

// Units the coverage check compares: CJK characters one by one, Latin words and
// numbers whole.
const COVERAGE_UNIT_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[A-Za-z]+|\d+(?:[.,]\d+)*/gu;

// The Latin content words of a title: two or more letters, not function words.
// The count tells a formula fragment from a naming phrase; neighbours are read,
// so a quantity's "a" counts where an infinitive "to" does not.
function contentWordCount(title: string): number {
	const tokens = englishTokens(title);
	let count = 0;
	for (let i = 0; i < tokens.length; i++) {
		if (!/^[A-Za-z]{2,}/u.test(tokens[i].text)) {
			continue;
		}
		if (!isEnglishFunctionWord(tokens, i)) {
			count++;
		}
	}
	return count;
}

// Whether a standalone coverage unit is a function word the pipeline may drop.
// No neighbours exist here, so only words that are glue everywhere are listed;
// "to" and "that" are context-sensitive and stay.
function isDroppableEnglishUnit(unit: string): boolean {
	const lower = normalizeEnglishWord(unit);
	if (isEnglishFunctionContraction(lower)) {
		return true;
	}
	const entry = ENGLISH_FUNCTION_WORD_INDEX.get(lower);
	if (!entry) {
		return false;
	}
	return (
		entry.kind === 'always' ||
		entry.kind === 'it' ||
		entry.kind === 'have' ||
		entry.kind === 'do' ||
		entry.kind === 'be'
	);
}

// A unit the title pipeline may drop without changing what it says: a CJK glue
// character, or an English function word (article, infinitive "to", copula or
// auxiliary).
function isDroppableUnit(unit: string): boolean {
	if (CJK_RUN_RE.test(unit)) {
		return CJK_GLUE_CHARS.has(unit);
	}
	if (/^\d/.test(unit)) {
		return false;
	}
	return isDroppableEnglishUnit(unit);
}

// Whether the title reproduces the consumed region from its first word on,
// dropping only function words, glue and punctuation. Such a title reads as the
// region itself, so the body may skip it; anything else is abridged and the body
// keeps the original.
function titleCoversRegion(title: string, region: string): boolean {
	const titleUnits = [...title.matchAll(COVERAGE_UNIT_RE)].map((match) => match[0].toLowerCase());
	const regionUnits = [...region.matchAll(COVERAGE_UNIT_RE)].map((match) => match[0].toLowerCase());
	if (!titleUnits.length || titleUnits[0] !== regionUnits[0]) {
		return false;
	}

	let r = 0;
	for (const unit of titleUnits) {
		while (r < regionUnits.length && regionUnits[r] !== unit) {
			if (!isDroppableUnit(regionUnits[r])) {
				return false;
			}
			r++;
		}
		if (r >= regionUnits.length) {
			return false;
		}
		r++;
	}

	// A region tail the title does not show must be droppable too, or the title
	// is a truncated prefix and the body has to keep the original.
	for (; r < regionUnits.length; r++) {
		if (!isDroppableUnit(regionUnits[r])) {
			return false;
		}
	}

	return true;
}

/**
 * Splits markdown into the line groups that become summaries. A group ends at a
 * blank line once it reaches `tokenTarget`; a fence stays in one group. While
 * streaming, the trailing unterminated line is held back.
 */
function splitReasoningBlocks(
	markdown: string,
	streaming: boolean,
	tokenTarget: number
): string[][] {
	const lines = (markdown ?? '').replace(/\r\n?/g, '\n').split('\n');
	const terminated = streaming ? Math.max(lines.length - 1, 0) : lines.length;
	const blocks: string[][] = [];
	const fence = new FenceState();
	let current: string[] = [];
	let tokens = 0;

	const flush = () => {
		blocks.push(current);
		current = [];
		tokens = 0;
	};

	for (let i = 0; i < terminated; i++) {
		const line = lines[i];
		const trimmed = line.trim();

		// A cut inside a fenced code block would break the code up, so the block
		// keeps growing until the fence closes.
		fence.consume(trimmed);

		// Once the block has reached its token target it ends at the next blank
		// line, so blocks also end at a paragraph boundary and not mid-paragraph.
		if (!fence.active && trimmed === '' && tokens >= tokenTarget) {
			flush();
			continue;
		}

		current.push(line);
		tokens += countReasoningTokens(line);
	}

	// While streaming, the text after the last newline is still being written:
	// it cannot be cut yet (a cut is always at a blank line) and does not count
	// toward the next cut either. It joins the pending block once its newline
	// arrives.
	for (let i = terminated; i < lines.length; i++) {
		current.push(lines[i]);
	}

	if (!streaming) {
		flush();
	}

	return blocks;
}

// ---------------------------------------------------------------------------
// Body extraction
//
// The body is the one or two most readable sentences of the block, shown
// verbatim: centrality and position carry the signal, a conclusion marker pays
// more near the end, session IDF discounts repeated vocabulary, and title
// overlap, an earlier block's sentence or a mid-clause cut are penalties. A body
// that already fits, or a block with no eligible sentence, keeps the prefix cut.
// ---------------------------------------------------------------------------

/** Points the block's most central sentence earns over an even share. */
const BODY_SCORE_CENTRALITY = 8;
/** Base points of a conclusion marker ("therefore", "综上"). */
const BODY_SCORE_CONCLUSION = 10;
/** Extra points a conclusion marker earns at the end of the block. */
const BODY_SCORE_CONCLUSION_POSITION = 8;
/**
 * An early conclusion-shaped sentence is often the block's framing ("所以
 * 用户可能希望…"), not its conclusion; the deduction fades toward the end.
 */
const BODY_SCORE_EARLY_CONCLUSION = 6;
/** Points a sentence of session-unique vocabulary earns over one of shared words. */
const BODY_SCORE_NOVELTY = 6;
/** Points per content word: a substantive sentence beats a leftover clause. */
const BODY_SCORE_CONTENT_WORD = 0.75;
/** Content words past this cap stop adding substance. */
const BODY_SCORE_CONTENT_WORD_CAP = 8;
/** A body sentence shorter than this is a leftover clause, not a statement. */
const BODY_MIN_TOKENS = 8;
/** A sentence must name at least this many content words to stand alone. */
const BODY_MIN_CONTENT_WORDS = 2;
/** Penalty for reproducing the title's content words. */
const BODY_PENALTY_TITLE_OVERLAP = 14;
/** Penalty for a sentence an earlier block already displayed. */
const BODY_PENALTY_REPEAT = 40;
/** A sentence this similar to an earlier body is skipped when another exists. */
const BODY_REPEAT_SKIP_SIMILARITY = 0.55;
/** Penalty for a sentence that has to be cut to fit the budget. */
const BODY_PENALTY_OVER_LIMIT = 6;
/** Extra penalty when the over-budget cut has no clause boundary to read at. */
const BODY_PENALTY_NO_CLAUSE = 6;
/** A sentence far past the budget loses more than one just over it. */
const BODY_PENALTY_FAR_OVER_LIMIT = 4;
/** Penalty for a reasoning beat ("let me…", "首先") that names no result. */
const BODY_PENALTY_FRAME = 10;
/** Penalty for a hedge/framing opener that is not a conclusion. */
const BODY_PENALTY_HEDGE = 5;
/** A label ending on a colon introduces code or a list; it is not a result. */
const BODY_PENALTY_LABEL = 5;
/**
 * Body tokens extraction fills up to: 0.8 x the visible limit (32 of 40). A body
 * that stops far below the budget reads as a fragment beside the block it
 * summarizes, so the unused room goes to the next-best sentences. The last fifth
 * stays free because a sentence that only fits by a cut costs more than it adds.
 */
const BODY_FILL_TARGET = 32;
/**
 * Lowest body score a filling sentence may have. The anchors already say what
 * the block concluded, so the free budget goes only to sentences that still earn
 * their place. Zero is too strict: a hedge, a label or a cut just over the limit
 * pays a few points and still reads as content, so a zero floor leaves the body
 * at half the budget. The value is calibrated on the corpus plus a seed-7
 * stand-in — see the comment on the fill loop — and sits below the light
 * penalties so they survive while a frame, a far-over-limit cut or a repeat does
 * not. Only the fill pass reads it: anchors, the conclusion pair and the single
 * fallback are chosen before it applies.
 */
const BODY_FILL_MIN_SCORE = -7;
/** A body sentence ends on a sentence mark, never on a comma or a colon. */
const BODY_TERMINAL_RE = /[.。！？!?…]$/u;
const BODY_CLOSING_MARKS_RE = /["'”’）)\]】」』]+$/u;

/**
 * A clause that continues something before it: a Chinese comma split often
 * leaves half a sentence ("特别是数据块的大小。"), which ends on a full stop but has
 * no subject. Conclusion connectives are absent on purpose: "所以…" is what the
 * body is looking for.
 */
const BODY_FRAGMENT_OPENER_RE =
	/^(?:特别是|尤其是|尤其|如前面|如前所述|如上|如下|而不是|而是|既|以及|或者|还是|并且|而且|但是|但|不过|然而|此外|另外|同时|接着|然后|最后|首先|其次|至于|关于|对于|由于|因为|如果|虽然|尽管|即使|除非|一旦|当|为了|以便|从而|进而|同样|这样|这么|那么|这种|那种|此|该|其)/u;

/** English sentences start with a capital; a lowercase start is a cut clause. */
const BODY_LOWERCASE_START_RE = /^[a-z]/u;
/**
 * A conversational beat ("Actually wait…", "嗯，…") is not a result sentence. The
 * Chinese branch needs no trailing boundary: 嗯 is a whole word at the sentence
 * start, and the clause join keeps the comma that follows it inside the
 * sentence, so any sentence opening on it is the same beat.
 */
const BODY_BEAT_OPENER_RE = /^(?:(?:actually|wait|hmm+|hm|oh|ah|okay|ok)\b|嗯)/iu;
/** A body sentence never opens on a closing mark or a lone punctuation mark. */
const BODY_BAD_START_RE = /^[\s,，、.。!！?？;；:：|]/u;
/** A math line, not prose: display/inline math at the start of the sentence. */
const BODY_MATH_LINE_RE = /^(?:\$\$?|\\\[|\\\()/u;

/** Strong conclusion markers: they state a result rather than the next step. */
const BODY_CONCLUSION_STRONG_RE =
	/(?:综上|总之|总的来说|结论是|答案是|由此可见|也就是说|这意味着|final answer|in conclusion|the answer is|therefore|thus|hence|conclude|conclusion)/iu;
/** Weaker markers: they often introduce a result but also a plan. */
const BODY_CONCLUSION_WEAK_RE = /(?:所以|因此|可见|最终|结果是|overall|in summary|as a result)/iu;
/** Strong English "so" only when it opens the sentence or follows a stop. */
const BODY_CONCLUSION_SO_RE = /(?:^|[.!?;:,]\s*)so\b/iu;

/** A line that is plainly code: a preprocessor line, a declaration or a brace. */
const BODY_CODE_LINE_RE =
	/^(?:#(?:define|include|if|ifdef|ifndef|else|elif|endif|pragma|undef)\b|(?:def|class|import|from|function|const|let|var|return|public|private|template|struct|typedef|switch|case)\b|[{}])/u;

type BodySentence = {
	index: number;
	/** The sentence as written, markdown already stripped. */
	text: string;
	/** Content-word bag used for the cross-block similarity. */
	bag: ReadonlyMap<string, number>;
	norm: number;
	score: number;
	/** 0 when the sentence states no conclusion, otherwise 0.7–1. */
	conclusion: number;
};

type BodyContext = {
	/** Bags of the sentences already shown as bodies in this summary call. */
	displayed: Array<{ bag: ReadonlyMap<string, number>; norm: number }>;
};

/** A reading unit of a block: joined clauses that read as one sentence. */
type BodyUnit = { start: number; end: number; text: string; centrality: number };

/** A content-word bag; numbers weigh more because they name a fact. */
function bodyBag(terms: readonly string[]): { bag: Map<string, number>; norm: number } {
	const bag = new Map<string, number>();
	let norm = 0;
	for (const term of terms) {
		if (bag.has(term)) {
			continue;
		}
		const weight = /^\d/u.test(term) ? 3 : 1;
		bag.set(term, weight);
		norm += weight * weight;
	}
	return { bag, norm: Math.sqrt(norm) };
}

/**
 * Terms a repeated body is recognised by: content words plus the numbers and
 * identifiers it names. "index 30–33 is 0000" and "positions 30–33 are 0000"
 * share no content word, but they are the same sentence to a reader.
 */
function bodySimilarityTerms(text: string): string[] {
	return [...contentWordTerms(text), ...(text.match(/\d+(?:[.,]\d+)*/gu) ?? [])];
}

/** The cross-block similarity digest of a text: a weighted bag and its norm. */
function bodyDigest(text: string): { bag: Map<string, number>; norm: number } {
	return bodyBag(bodySimilarityTerms(text));
}

/** Whether `text` ends as a complete sentence (a closing mark may follow). */
function endsAsSentence(text: string): boolean {
	const trimmed = text.trim().replace(BODY_CLOSING_MARKS_RE, '');
	return BODY_TERMINAL_RE.test(trimmed);
}

/** Conclusion strength of a sentence, in [0, 1]. */
function conclusionSignal(text: string): number {
	if (BODY_CONCLUSION_STRONG_RE.test(text)) {
		return 1;
	}
	if (BODY_CONCLUSION_WEAK_RE.test(text) || BODY_CONCLUSION_SO_RE.test(text)) {
		return 0.7;
	}
	return 0;
}

/** Whether a span is a structural line (heading, list item, table, fence). */
function isStructuralBodyLine(text: string): boolean {
	return (
		LIST_ITEM_RE.test(text) ||
		/^(?:\s*#{1,6}\s|\s*>|\s*\||\s*```|\s*~~~|\s*\d{1,3}[.)]\s)/u.test(text)
	);
}

/**
 * Reading units for the body: `splitSentences` also cuts at a Chinese comma, so
 * clauses on one line are joined until a sentence mark. A newline always ends a
 * unit, so list lines and headings never absorb prose. Centrality is the
 * strongest clause, read from the S1 vector.
 */
function collectBodyUnits(
	blockText: string,
	sentences: SentenceSpan[],
	centrality: readonly number[],
	codeRanges: ReadonlyArray<{ start: number; end: number }>
): BodyUnit[] {
	const units: BodyUnit[] = [];
	const inCode = (sentence: SentenceSpan) =>
		codeRanges.some((range) => sentence.start < range.end && sentence.end > range.start);

	for (let index = 0; index < sentences.length; index++) {
		const first = sentences[index];
		if (inCode(first)) {
			continue;
		}

		let last = index;
		let text = first.text.trim();
		let unitCentrality = centrality[index] ?? 0;
		const structural = isStructuralBodyLine(text);

		while (!endsAsSentence(text) && !structural && last + 1 < sentences.length) {
			const next = sentences[last + 1];
			// A newline is a hard boundary: joining across it would merge a list
			// item or a heading into the next line's prose.
			if (blockText.slice(sentences[last].end, next.start).includes('\n') || inCode(next)) {
				break;
			}
			last++;
			text = blockText.slice(first.start, sentences[last].end).trim();
			unitCentrality = Math.max(unitCentrality, centrality[last] ?? 0);
		}

		units.push({ start: first.start, end: sentences[last].end, text, centrality: unitCentrality });
		index = last;
	}

	return units;
}

/** The reading units of a block, with the code ranges already dropped. */
function bodyUnits(blockText: string): BodyUnit[] {
	const sentences = splitSentences(blockText);
	return collectBodyUnits(
		blockText,
		sentences,
		sentenceCentrality(blockText, sentences),
		fencedCodeRanges(blockText)
	);
}

/** The strongest cosine or containment a candidate has against a shown body. */
function repeatedSimilarity(
	bag: ReadonlyMap<string, number>,
	norm: number,
	displayed: BodyContext['displayed']
): number {
	let best = 0;
	for (const previous of displayed) {
		let dot = 0;
		for (const [term, weight] of bag) {
			const other = previous.bag.get(term);
			if (other !== undefined) {
				dot += weight * other;
			}
		}
		if (dot === 0) {
			continue;
		}
		const cosine = dot / (norm * previous.norm);
		// A short restatement is one clause of the earlier body: cosine dilutes
		// it by the body's extra words, so the containment coefficient gets the
		// same shared content to count.
		const containment = dot / Math.min(norm * norm, previous.norm * previous.norm);
		best = Math.max(best, cosine, containment);
	}
	return best;
}

/**
 * Whether a digest restates a body an earlier block showed. The same threshold
 * governs the source gate and the per-candidate skip, so both agree.
 */
function restatesShownBody(
	digest: { bag: ReadonlyMap<string, number>; norm: number },
	displayed: BodyContext['displayed']
): boolean {
	return repeatedSimilarity(digest.bag, digest.norm, displayed) >= BODY_REPEAT_SKIP_SIMILARITY;
}

/** Puts a body that is on screen into the repeat set later blocks read. */
function recordDisplayedBody(
	displayed: BodyContext['displayed'],
	digest: { bag: ReadonlyMap<string, number>; norm: number }
): void {
	displayed.push({ bag: digest.bag, norm: digest.norm });
}

/** Whether a text stays inside the visible body budget. */
function fitsBodyBudget(text: string, tokenLimit: number): boolean {
	return countReasoningTokens(text) <= tokenLimit;
}

/** Character ranges covered by fenced code, fences included. */
function fencedCodeRanges(text: string): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	const fence = new FenceState();
	let start = -1;
	let offset = 0;
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (fence.consume(trimmed)) {
			if (start === -1) {
				start = offset;
			} else {
				ranges.push({ start, end: offset + line.length });
				start = -1;
			}
		}
		offset += line.length + 1;
	}
	if (start !== -1) {
		ranges.push({ start, end: text.length });
	}
	return ranges;
}

/** Whether brackets and parentheses in `text` are balanced. */
function hasBalancedBrackets(text: string): boolean {
	let depth = 0;
	for (const char of text) {
		if ('（(【[「『'.includes(char)) {
			depth++;
		} else if ('）)】]」』'.includes(char)) {
			depth--;
			if (depth < 0) {
				return false;
			}
		}
	}
	return depth === 0;
}

/**
 * Whether a sentence can stand as a body sentence. Code, a table row, a bare list
 * marker, a formula fragment, a lone discourse marker and a sentence cut before
 * its end are not body material.
 */
function isBodySentence(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed || isDiscourseMarkerOnly(trimmed)) {
		return false;
	}
	if (/^(?:```|~~~|\|)/u.test(trimmed) || BODY_CODE_LINE_RE.test(trimmed)) {
		return false;
	}
	if (BODY_MATH_LINE_RE.test(trimmed)) {
		return false;
	}
	if (isFormulaFragmentTitle(trimmed) || isCodeLikeTitle(trimmed)) {
		return false;
	}
	if (!endsAsSentence(trimmed)) {
		return false;
	}
	if (BODY_BAD_START_RE.test(trimmed) || BODY_FRAGMENT_OPENER_RE.test(trimmed)) {
		return false;
	}
	// English prose starts with a capital; a lowercase start is the tail of a
	// sentence the splitter cut ("suggesting there's a unique answer.").
	if (!CJK_RUN_RE.test(trimmed) && BODY_LOWERCASE_START_RE.test(trimmed)) {
		return false;
	}
	if (BODY_BEAT_OPENER_RE.test(trimmed)) {
		return false;
	}
	if (!hasBalancedBrackets(trimmed)) {
		return false;
	}
	if (countReasoningTokens(trimmed) < BODY_MIN_TOKENS) {
		return false;
	}
	const terms = contentWordTerms(trimmed);
	if (terms.length < BODY_MIN_CONTENT_WORDS) {
		return false;
	}
	return true;
}

/**
 * Session novelty: a sentence built from words every block repeats is less
 * informative than one naming this block's vocabulary. With a neutral corpus
 * every weight is 1, so the term is a constant and the order is undisturbed.
 */
function bodyNovelty(terms: readonly string[], contentIdf: ContentIdf): number {
	let weightSum = 0;
	for (const term of terms) {
		weightSum += contentIdf.weights.get(term) ?? 1;
	}
	const meanWeight = terms.length ? weightSum / terms.length : 1;
	return (
		BODY_SCORE_NOVELTY *
		Math.max(0, (meanWeight - TITLE_IDF_WEIGHT_FLOOR) / (1 - TITLE_IDF_WEIGHT_FLOOR))
	);
}

/**
 * A title source that the title reproduces is removed before this pass; a
 * sentence that merely shares words with the title is still wanting.
 */
function titleOverlapPenalty(terms: readonly string[], titleTerms: readonly string[]): number {
	if (!titleTerms.length) {
		return 0;
	}
	const titleSet = new Set(titleTerms);
	let shared = 0;
	for (const term of terms) {
		if (titleSet.has(term)) {
			shared++;
		}
	}
	return BODY_PENALTY_TITLE_OVERLAP * (shared / titleTerms.length);
}

/** Conclusion points, read against the sentence's position in the block. */
function applyConclusionPoints(score: number, conclusion: number, position: number): number {
	if (conclusion === 0) {
		return score;
	}
	let next = score + BODY_SCORE_CONCLUSION * conclusion;
	next += BODY_SCORE_CONCLUSION_POSITION * conclusion * position;
	next -= BODY_SCORE_EARLY_CONCLUSION * conclusion * (1 - position) ** 2;
	return next;
}

/**
 * An over-budget sentence pays for its cut. A cut at a clause boundary still
 * reads as a sentence fragment; a cut inside a word run reads as a telegraph.
 * Only the head matters: the tail is what gets dropped.
 */
function applyOverLimitPenalty(score: number, text: string, tokenLimit: number): number {
	const tokens = countReasoningTokens(text);
	if (tokens <= tokenLimit) {
		return score;
	}
	let next = score - BODY_PENALTY_OVER_LIMIT;
	if (tokens > tokenLimit * 1.5) {
		next -= BODY_PENALTY_FAR_OVER_LIMIT;
	}
	const head = text.slice(0, Math.ceil((text.length * tokenLimit) / tokens));
	next += /[，、；：,;:]/u.test(head) ? BODY_PENALTY_NO_CLAUSE / 2 : -BODY_PENALTY_NO_CLAUSE;
	return next;
}

/**
 * Rhythm and framing, used only by the body score. The S1 gate names the openers
 * that read as a beat; a conclusion marker is what a "所以…" sentence is, so it
 * cancels the frame penalty. A label ending on a colon introduces code or a
 * list, not a result.
 */
function applyFramingPenalty(score: number, text: string, conclusion: number): number {
	let next = score;
	if (conclusion === 0) {
		if (TOPIC_PROCESS_CORE_RE.test(text) || TOPIC_SENTENCE_SKIP_RE.test(text)) {
			next -= BODY_PENALTY_FRAME;
		}
		if (TITLE_CONNECTIVE_OPENER_RE.test(text) || TITLE_HEDGE_OPENER_RE.test(text)) {
			next -= BODY_PENALTY_HEDGE;
		}
	}
	if (/[：:]$/u.test(text)) {
		next -= BODY_PENALTY_LABEL;
	}
	return next;
}

/** One candidate sentence with its body score. */
function scoreBodySentence(args: {
	index: number;
	text: string;
	count: number;
	centrality: number;
	titleTerms: readonly string[];
	contentIdf: ContentIdf;
	repeated: number;
	tokenLimit: number;
}): BodySentence {
	const { index, text, count, centrality, titleTerms, contentIdf, repeated, tokenLimit } = args;
	const terms = contentWordTerms(text);
	const { bag, norm } = bodyBag(terms);
	const conclusion = conclusionSignal(text);
	const position = count <= 1 ? 1 : index / (count - 1);

	let score = BODY_SCORE_CENTRALITY * centrality;
	// A leftover clause can carry rare words, but it does not carry the block's
	// content: substance is content words as well as novelty.
	score += BODY_SCORE_CONTENT_WORD * Math.min(terms.length, BODY_SCORE_CONTENT_WORD_CAP);
	score += bodyNovelty(terms, contentIdf);
	// The adjustments thread the running score: the accumulation order is part
	// of the tuned scores and a delta could round differently.
	score = applyConclusionPoints(score, conclusion, position);
	score -= titleOverlapPenalty(terms, titleTerms);
	// A sentence an earlier block already showed is usually the model restating
	// itself; the earlier block is already on screen, so this one yields.
	score -= BODY_PENALTY_REPEAT * repeated;
	score = applyOverLimitPenalty(score, text, tokenLimit);
	score = applyFramingPenalty(score, text, conclusion);
	return { index, text, bag, norm, score, conclusion };
}

/**
 * Whether any sentence of `content` restates a body an earlier block showed.
 * Checking sentence by sentence keeps the fits gate cheap: no sentence graph is
 * built for the common case.
 */
function showsRepeatedSentence(content: string, displayed: BodyContext['displayed']): boolean {
	if (!displayed.length) {
		return false;
	}
	return splitSentences(content).some((sentence) =>
		restatesShownBody(bodyDigest(sentence.text), displayed)
	);
}

/**
 * Scores every reading unit that can stand as body material. The title's own
 * source is dropped when the title reproduces it, and a heading, table row, list
 * item or fragment never qualifies; a unit an earlier body already showed keeps
 * its similarity as a penalty instead of being dropped here.
 */
function collectBodyCandidates(args: {
	units: readonly BodyUnit[];
	title: string;
	consumed: number;
	keepOriginal: boolean;
	contentIdf: ContentIdf;
	displayed: BodyContext['displayed'];
	tokenLimit: number;
}): BodySentence[] {
	const { units, title, consumed, keepOriginal, contentIdf, displayed, tokenLimit } = args;
	const titleTerms = titleContentWordTerms(title);
	const candidates: BodySentence[] = [];

	for (let index = 0; index < units.length; index++) {
		const unit = units[index];
		// The title's own source is not body material when the title reproduces
		// it; when the title abridged the region, the original stays available
		// because the title may not carry all of it.
		if (!keepOriginal && consumed > 0 && unit.start < consumed) {
			continue;
		}
		// A heading, table row or list item is not a sentence: its punctuation
		// is often missing, and a stripped bullet would leave a fragment.
		if (isStructuralBodyLine(unit.text.trim())) {
			continue;
		}
		const text = stripBodyMarkdown(unit.text).trim();
		if (!isBodySentence(text)) {
			continue;
		}
		const digest = bodyDigest(text);
		candidates.push(
			scoreBodySentence({
				index,
				text,
				count: units.length,
				centrality: unit.centrality,
				titleTerms,
				contentIdf,
				repeated: repeatedSimilarity(digest.bag, digest.norm, displayed),
				tokenLimit
			})
		);
	}

	return candidates;
}

/**
 * Puts a filled sentence back in reading order: before the first selected
 * sentence that starts later in the block and after every earlier one. The
 * initial pair keeps the order the conclusion rule gave it, so a conclusion
 * that sits early in the block is still shown last.
 */
function insertInBodyOrder(selected: BodySentence[], candidate: BodySentence): void {
	const at = selected.findIndex((sentence) => sentence.index > candidate.index);
	selected.splice(at === -1 ? selected.length : at, 0, candidate);
}

/**
 * Picks the sentences the body shows. A near-duplicate of an earlier body steps
 * aside while a fresh alternative exists; if every sentence was already shown,
 * the best one still stands. The second sentence crosses the dry/conclusion split
 * so a result is shown next to its claim, and a lone over-budget sentence is cut
 * at a word boundary.
 *
 * A pair of short sentences leaves most of the budget unused, so the remaining
 * candidates are tried best-first until the body reaches `BODY_FILL_TARGET`: the
 * block's own material is preferred to a body that reads as a fragment. Only
 * candidates that pass the collect filters are tried, a sentence that would
 * cross the limit is skipped instead of cut, and an exact repeat is passed over,
 * so a block with nothing left to say keeps the body it had. A filled sentence is
 * a budget top-up rather than a representative sentence, so it leaves the repeat
 * set alone: a later block is never shortened because this one padded itself. The
 * cost is that a later block may restate the padding.
 */
function pickBodySentences(
	candidates: readonly BodySentence[],
	displayed: BodyContext['displayed'],
	tokenLimit: number
): { anchors: BodySentence[]; text: string; truncated: boolean } {
	const fresh = candidates.filter((candidate) => !restatesShownBody(candidate, displayed));
	const pool = [...(fresh.length ? fresh : candidates)].sort(
		(a, b) => b.score - a.score || a.index - b.index
	);
	const top = pool[0];

	const counterpart =
		top.conclusion > 0
			? pool.find((candidate) => candidate.conclusion === 0)
			: pool
					.filter((candidate) => candidate.conclusion > 0)
					.sort((a, b) => b.conclusion - a.conclusion || b.score - a.score)[0];

	const selected: BodySentence[] = [];
	if (counterpart && counterpart !== top) {
		// A conclusion reads at the end of the body; otherwise the highest
		// scoring sentence leads and the conclusion follows.
		const ordered = top.conclusion > 0 ? [counterpart, top] : [top, counterpart];
		if (fitsBodyBudget(ordered.map((candidate) => candidate.text).join(' '), tokenLimit)) {
			selected.push(...ordered);
		}
	}

	if (!selected.length) {
		// Only one sentence fits. A complete sentence beats a truncated one, and
		// a conclusion beats a claim.
		const one = [top, counterpart].filter((candidate): candidate is BodySentence => !!candidate);
		const fitting = one.filter((candidate) => fitsBodyBudget(candidate.text, tokenLimit));
		selected.push(
			fitting.find((candidate) => candidate.conclusion > 0) ??
				fitting[0] ??
				one.find((candidate) => candidate.conclusion > 0) ??
				top
		);
	}

	// Fill the rest of the budget. The candidate list is already filtered (no
	// leftover clause, heading, table row, list item or sentence an earlier body
	// showed) and `pool` is best-first, so filling adds what this block itself
	// said rather than filler. The order is the block's own, so the body reads
	// forward; a candidate that does not fit is left out whole. These sentences
	// are not anchors: they do not enter the repeat set the next block reads.
	const anchors = [...selected];
	if (fresh.length) {
		let tokens = 0;
		for (const sentence of selected) {
			tokens += countReasoningTokens(sentence.text);
		}
		for (const candidate of pool) {
			if (tokens >= BODY_FILL_TARGET) {
				break;
			}
			// `pool` is best-first, so the first candidate below the floor ends
			// the pass: nothing after it can clear the floor either. The floor is
			// calibrated: on the corpus plus the seed-7 stand-in, a zero floor cost
			// 11 points of ≥32 bodies, while -7 costs 4.4 and still rejects frames
			// and the heaviest over-limit cuts.
			if (candidate.score < BODY_FILL_MIN_SCORE) {
				break;
			}
			if (
				selected.includes(candidate) ||
				selected.some((sentence) => sentence.text === candidate.text)
			) {
				continue;
			}
			const added = countReasoningTokens(candidate.text);
			if (tokens + added > tokenLimit) {
				continue;
			}
			insertInBodyOrder(selected, candidate);
			tokens += added;
		}
	}

	let text = selected.map((candidate) => candidate.text).join(' ');
	let truncated = false;
	if (!fitsBodyBudget(text, tokenLimit)) {
		const cut = truncateReasoningTokens(text, tokenLimit);
		text = cut.text;
		truncated = cut.truncated;
	}
	return { anchors, text, truncated };
}

/**
 * The body sentences of a block, or null when the prefix behaviour should stand.
 * `blockText` is the block as written, so its sentence graph is the one S1
 * cached; `content` is the text the prefix cut would show, used to decide whether
 * extraction is needed and as the fallback.
 */
function extractBodySentences(
	blockText: string,
	content: string,
	title: string,
	consumed: number,
	keepOriginal: boolean,
	contentIdf: ContentIdf,
	tokenLimit: number,
	context: BodyContext
): { text: string; truncated: boolean } | null {
	// A body that already fits is complete: there is nothing to improve by
	// reordering it, and keeping every sentence is more faithful. The one
	// exception is a body an earlier block already showed: then the block still
	// yields the repetition and lets a fresh sentence through.
	if (fitsBodyBudget(content, tokenLimit) && !showsRepeatedSentence(content, context.displayed)) {
		return null;
	}

	const units = bodyUnits(blockText);
	const candidates = collectBodyCandidates({
		units,
		title,
		consumed,
		keepOriginal,
		contentIdf,
		displayed: context.displayed,
		tokenLimit
	});
	if (!candidates.length) {
		return null;
	}

	const { anchors, text, truncated } = pickBodySentences(candidates, context.displayed, tokenLimit);
	if (!text) {
		return null;
	}
	// Only the anchors describe this block: the padding a fill adds stays out of
	// the repeat set, so it cannot shorten a later block's body.
	for (const candidate of anchors) {
		recordDisplayedBody(context.displayed, candidate);
	}
	return { text, truncated };
}

type SummaryDraft = {
	blockText: string;
	candidate: TitleCandidate;
	/** The session corpus this block's title and body were scored against. */
	contentIdf: ContentIdf;
	/**
	 * The complete title pool the candidate was chosen from; empty for a
	 * structural title. Kept until the call renders the drafts so the non-streaming
	 * diversity repair can take the block's next-best candidate.
	 */
	candidates: EnhancedCandidate[];
	/**
	 * Body tokens that joined this draft from later titleless blocks. Only a
	 * titled draft is a merge target; the total is capped so a long run of
	 * formula blocks cannot grow one summary without bound.
	 */
	mergedTokens?: number;
	/** The title and pool came from the fallback layer, so re-choice uses it. */
	fallback?: boolean;
};

// A titleless block short enough to merge into the previous block's raw text.
// Returns the raw block text when it qualifies; null when it needs a summary of
// its own. The summary body may later cut it away with the normal token limit.
function shortSummaryBlock(blockText: string, candidate: TitleCandidate): string | null {
	if (candidate.title || countReasoningTokens(blockText) > REASONING_SUMMARY_MERGE_TOKEN_LIMIT) {
		return null;
	}

	const body = stripBodyMarkdown(blockText);
	if (!body || countReasoningTokens(body) > REASONING_SUMMARY_MERGE_TOKEN_LIMIT) {
		return null;
	}

	return blockText;
}

/**
 * What a merged block contributes to the pool. A visible body is cut at
 * `REASONING_SUMMARY_TOKEN_LIMIT`, so a block can add at most that much; counting
 * the raw block would reject every full-size block and kill the merge layer in
 * exactly the formula-heavy reasoning it exists for.
 */
function mergeContributionTokens(blockText: string): number {
	return Math.min(countReasoningTokens(blockText), REASONING_SUMMARY_TOKEN_LIMIT);
}

/**
 * Whether the body pass would show nothing once the title's source is lifted.
 * This runs the same exclusion chain as `collectBodyCandidates` — the title
 * source, structural lines, markdown stripping, sentence shape and the content
 * thresholds — so the merge decision cannot drift from what `draftBody` renders.
 * IDF and the token budget only move scores, never membership, so the neutral
 * corpus is enough; the call is O(block) and happens once, when the block
 * settles, so no tick recomputes it.
 */
function bodyWouldBeEmpty(
	blockText: string,
	title: string,
	consumed: number,
	keepOriginal: boolean
): boolean {
	return (
		collectBodyCandidates({
			units: bodyUnits(blockText),
			title,
			consumed,
			keepOriginal,
			contentIdf: NEUTRAL_CONTENT_IDF,
			displayed: [],
			tokenLimit: REASONING_SUMMARY_TOKEN_LIMIT
		}).length === 0
	);
}

/**
 * A block that is only its own title: "Write in Chinese, technical." The title
 * derivation is satisfied — the opening sentence clears the prose floor — but
 * the body pass then lifts that sentence as the title's source, leaving an empty
 * draft. The block carries no topic beyond the title, so it should ride under
 * the previous summary instead of rendering as a title over nothing.
 *
 * Conditions, all read from the block as written:
 * - exactly one `splitSentences` span (for CJK that also rules out an internal
 *   comma clause, so the whole block is one sentence);
 * - the title reproduces that sentence from its first word to its last, dropping
 *   only function words, glue and punctuation (`titleCoversRegion`), so it is the
 *   sentence as a title rather than a synthesis beside it;
 * - the body pass, with the same exclusion chain body extraction runs, leaves no
 *   candidate: the title-source sentence was the block's only material.
 *
 * Structural titles are excluded by the caller (`selection.prose` is false for a
 * label, heading, list item, quote or fence): those blocks render the line that
 * named them, so a structural title is not a prose sentence lifted out of its
 * own block. A lone heading stays its own draft (titleless or titled), while a
 * prose sentence taken whole is the case this rule folds away.
 */
function contentlessSummaryBlock(blockText: string, candidate: TitleCandidate): boolean {
	const { title, consumed, abridged } = candidate;
	if (!title) return false;
	const sentences = splitSentences(blockText);
	if (sentences.length !== 1) return false;
	const sentence = sentences[0];
	// The title source has to sit inside the unique sentence, and the title has
	// to reproduce that sentence, not merely the source prefix.
	if (consumed > sentence.end) return false;
	if (!titleCoversRegion(title, blockText.slice(sentence.start, sentence.end))) return false;
	// Same shaping `draftBody` uses: an abridged title that does not reproduce
	// its region leaves the original sentence as body material.
	const keepOriginal = abridged && !titleCoversRegion(title, blockText.slice(0, consumed));
	if (keepOriginal) return false;
	return bodyWouldBeEmpty(blockText, title, consumed, keepOriginal);
}

/** A titled draft that has not been rendered yet can still take one more block. */
function canMergeIntoDraft(draft: SummaryDraft | null, blockText: string): boolean {
	return (
		!!draft &&
		!!draft.candidate.title &&
		(draft.mergedTokens ?? 0) + mergeContributionTokens(blockText) <=
			REASONING_SUMMARY_MERGE_POOL_TOKEN_LIMIT
	);
}

function mergeIntoDraft(draft: SummaryDraft, blockText: string): void {
	draft.blockText = `${draft.blockText}\n${blockText}`;
	draft.mergedTokens = (draft.mergedTokens ?? 0) + mergeContributionTokens(blockText);
}

type ExpansionOutcome =
	| { status: 'pending'; consumed: number }
	| {
			status: 'ready';
			consumed: number;
			blockText: string;
			selection: TitleSelection;
			contentIdf: ContentIdf;
	  }
	| { status: 'failed'; consumed: number };

/**
 * Forward expansion of a titleless prose block.
 *
 * The base block closed at the ordinary cut and its title derivation failed.
 * Instead of rendering it bare or folding it into the previous summary, the
 * block keeps reading: it absorbs following blocks until it has added
 * `REASONING_SUMMARY_EXPAND_TOKEN_TARGET` tokens, cuts at that blank line, and
 * re-derives the title over the whole region. Success ends the expansion and the
 * region becomes one summary; failure spends a stage and absorbs 200 more, up to
 * `REASONING_SUMMARY_EXPAND_STAGES`. When the text runs out, `final` closes the
 * window with whatever was absorbed; a failed attempt consumes nothing, so the
 * caller keeps the base block exactly as it was.
 *
 * The function is stateless — it rescans from `index` on every call — so a
 * streaming caller simply calls it again when another block closes, and batch
 * and incremental paths share one decision procedure.
 */
function expandTitlelessBlock(args: {
	blocks: readonly string[];
	index: number;
	/** IDF for the corpus prefix that ends at the given block index (exclusive). */
	contentIdfAt: (end: number) => ContentIdf;
	context: TitleContext;
	/** The text is complete: a short window is concluded instead of held. */
	final: boolean;
	/**
	 * Absorbed-token boundaries already re-derived and rejected for this window.
	 * A streaming rescan sees the same region and prefix IDF, so remembering the
	 * attempt keeps a stalled window at one derivation per stage.
	 */
	attempted?: Set<number>;
}): ExpansionOutcome {
	const { blocks, index, contentIdfAt, context, final, attempted } = args;
	const texts = [blocks[index]];
	let next = index + 1;
	let absorbed = 0;
	/** Absorbed tokens at the start of the current stage. */
	let boundary = 0;
	let stages = 0;

	while (true) {
		while (next < blocks.length && absorbed - boundary < REASONING_SUMMARY_EXPAND_TOKEN_TARGET) {
			texts.push(blocks[next]);
			absorbed += countReasoningTokens(blocks[next]);
			next++;
		}

		// Nothing new arrived since the last attempt: retrying the same region
		// cannot produce a different title.
		if (absorbed === boundary) {
			return final ? { status: 'failed', consumed: 1 } : { status: 'pending', consumed: 1 };
		}

		if (!attempted?.has(absorbed)) {
			const blockText = texts.join('\n');
			const contentIdf = contentIdfAt(next);
			const selection = deriveReasoningSummaryTitle(blockText, contentIdf, context);
			if (selection.candidate.title) {
				return {
					status: 'ready',
					consumed: next - index,
					blockText,
					selection,
					contentIdf
				};
			}
			attempted?.add(absorbed);
		}

		stages++;
		boundary = absorbed;
		if (
			stages >= REASONING_SUMMARY_EXPAND_STAGES ||
			absorbed >= REASONING_SUMMARY_EXPAND_TOKEN_LIMIT
		) {
			return { status: 'failed', consumed: next - index };
		}
		if (next >= blocks.length) {
			// A streaming call may still receive the text this stage was waiting
			// for; only the finished text concludes the window here.
			return final
				? { status: 'failed', consumed: next - index }
				: { status: 'pending', consumed: next - index };
		}
	}
}

/** The IDF a block or window is scored against: whole corpus, or its prefix. */
function summaryIdfAt(state: PreviewState, end: number): ContentIdf {
	return state.sessionIdf ?? buildContentIdf(state.corpus.slice(0, end));
}

/**
 * Turns blocks into drafts before any summary is rendered (compatibility shim).
 *
 * The incremental engine is the single decision procedure: this feeds the block
 * texts into a fresh state exactly as the streaming scan does, runs the same
 * per-block steps to the end, and returns the drafts that were not rendered. A
 * finished call scores every block against the whole corpus; a streaming call
 * keeps the prefix scope, holds the last titled draft and never repairs
 * diversity. A spent expansion window is not replayed here — a batch call has no
 * state to carry, so the block settles under the ordinary titleless path.
 */
function collectSummaryDrafts(blocks: string[][], streaming: boolean): SummaryDraft[] {
	const state = createPreviewState();
	state.corpus = blocks.map((lines) => prepareBlockText(lines)).filter((text) => text !== '');
	// A finished reasoning knows every document a title may see; a streaming
	// call must not let a later block re-score a title already returned, so each
	// block sees only the prefix that ends at itself.
	state.sessionIdf = streaming ? null : buildContentIdf(state.corpus);
	state.summariesEnabled = true;

	advanceSummaryState(state, !streaming, false);

	if (!streaming) {
		releasePendingDraft(state);
		repairTitleDiversity(state.renderQueue);
	}
	return state.renderQueue;
}

/**
 * Resolves the title collisions left by the causal pass. For each pair above the
 * threshold, the less specific title (the later block on a tie) is re-chosen
 * against every other title, so a converged, specific title keeps its place;
 * structural titles cannot be re-chosen.
 *
 * `fixed` holds titles that were already shown: they take part in the comparison
 * and the re-choice but are never the loser, so a finished reasoning diversifies
 * its still-open blocks against what the reader already sees.
 */
function repairTitleDiversity(drafts: SummaryDraft[], fixed: readonly TitleBag[] = []): void {
	type Entry = { draft: SummaryDraft | null; bag: TitleBag; fixed: boolean };
	const entries: Entry[] = [
		...fixed.map((bag) => ({ draft: null, bag, fixed: true })),
		...drafts
			.filter((draft) => draft.candidate.title)
			.map((draft) => ({ draft, bag: titleBag(draft.candidate.title), fixed: false }))
	];
	if (entries.length < 2) {
		return;
	}

	// Two passes resolve the common case (one collision moves away from the
	// other member) without letting a repair chain run unbounded.
	for (let pass = 0; pass < 2; pass++) {
		let changed = false;
		const repaired = new Set<Entry>();

		for (let i = 0; i < entries.length; i++) {
			for (let j = i + 1; j < entries.length; j++) {
				const a = entries[i];
				const b = entries[j];
				if (titleBagSimilarity(a.bag, b.bag) <= TITLE_DIVERSITY_SIMILARITY) {
					continue;
				}
				// Two titles already on screen cannot yield.
				if (a.fixed && b.fixed) {
					continue;
				}

				// The less specific title yields; on equal specificity the later
				// block yields, matching the causal pass. A fixed title never yields.
				let loser = a;
				let other = b;
				if (a.fixed) {
					loser = b;
					other = a;
				} else if (b.fixed) {
					loser = a;
					other = b;
				} else if (
					a.bag.terms.size > b.bag.terms.size ||
					(a.bag.terms.size === b.bag.terms.size && i < j)
				) {
					loser = b;
					other = a;
				}
				// A structural title is right by construction: try the other side.
				if (!loser.fixed && !loser.draft!.candidates.length) {
					if (other.fixed || !other.draft!.candidates.length || repaired.has(other)) {
						continue;
					}
					[loser, other] = [other, loser];
				}
				if (repaired.has(loser) || !loser.draft) {
					continue;
				}

				const reference = entries.filter((entry) => entry !== loser).map((entry) => entry.bag);
				const replacement = chooseBestCandidate(
					loser.draft.candidates,
					loser.draft.blockText.replace(/\n/g, ' '),
					reference,
					0,
					loser.draft.fallback === true
				);
				repaired.add(loser);
				if (!replacement.title) {
					continue;
				}
				const title = capitalizeTitleLead(replacement.title);
				if (title === loser.draft.candidate.title) {
					continue;
				}

				loser.draft.candidate = { ...replacement, title };
				loser.bag = titleBag(title);
				changed = true;
			}
		}

		if (!changed) {
			break;
		}
	}
}

/**
 * The body a draft shows: extracted when the block needs it, otherwise the
 * prefix cut. A fallback body is on screen too, so it joins the repeat set.
 */
function draftBody(
	draft: SummaryDraft,
	tokenLimit: number,
	bodyContext: BodyContext
): { text: string; truncated: boolean } {
	const { blockText, candidate, contentIdf } = draft;
	const { title, consumed, abridged } = candidate;
	const keepOriginal = abridged && !titleCoversRegion(title, blockText.slice(0, consumed));
	const content = stripBodyMarkdown(title && !keepOriginal ? blockText.slice(consumed) : blockText);
	const extracted = extractBodySentences(
		blockText,
		content,
		title,
		consumed,
		keepOriginal,
		contentIdf,
		tokenLimit,
		bodyContext
	);
	if (extracted) {
		return extracted;
	}
	const cut = truncateReasoningTokens(content, tokenLimit);
	// A fallback body is on screen too: a later block must see it as a repeat.
	if (cut.text) {
		recordDisplayedBody(bodyContext.displayed, bodyDigest(cut.text));
	}
	return cut;
}

/**
 * Renders a merged draft once. Appended short blocks are part of the raw source,
 * so normal body extraction and the token cut decide whether they fit.
 */
function renderSummaryDraft(
	draft: SummaryDraft,
	tokenLimit: number,
	bodyContext: BodyContext
): ReasoningSummary | null {
	const { title } = draft.candidate;
	const { text: body, truncated } = draftBody(draft, tokenLimit, bodyContext);
	if (!title && !body) {
		return null;
	}
	return { title, body, truncated };
}

export function buildReasoningSummary(
	markdown: string,
	{
		streaming = false,
		tokenTarget = REASONING_SUMMARY_TOKEN_TARGET,
		tokenLimit = REASONING_SUMMARY_TOKEN_LIMIT
	}: BuildReasoningSummaryOptions = {}
): ReasoningSummary[] {
	const drafts = collectSummaryDrafts(
		splitReasoningBlocks(markdown, streaming, tokenTarget),
		streaming
	);
	// One body context per call: a sentence shown by an earlier draft is a
	// repeat in the next one.
	const bodyContext: BodyContext = { displayed: [] };
	return drafts
		.map((draft) => renderSummaryDraft(draft, tokenLimit, bodyContext))
		.filter((summary): summary is ReasoningSummary => summary !== null);
}

/**
 * Title for the live preview: the last finalized summary's title. A closed block
 * is held while the next one decides whether it merges, so a title still waiting
 * on a merge — or belonging to the trailing unfinished block — is never shown.
 * The scan is incremental and cached per `cacheId`; `done` releases the title.
 */
export function deriveReasoningSummaryPreview(
	cacheId: string,
	markdown: string,
	done = false
): string {
	const text = markdown ?? '';
	if (!text) {
		return '';
	}

	const state = cacheId ? previewStateFor(cacheId) : createPreviewState();
	processPreviewState(state, text);
	if (done) {
		finalizePreviewTitle(state);
	}

	return state.lastFinalizedTitle;
}

/**
 * Summaries for a streaming reasoning, derived only when a block closes.
 *
 * The same per-`cacheId` scan feeds the preview: every tick appends the lines
 * that arrived, and a block's title and body are computed once, when it closes.
 * A tick that closes no block returns the array handed out last time (the same
 * reference), so nothing downstream re-renders while a block is being written.
 *
 * Streaming holds the last titled draft until the next block decides whether it
 * merges a short titleless tail; `done` releases it, folds the trailing line in,
 * and repairs diversity over the blocks not returned yet. An already returned
 * summary is never rewritten.
 */
export function deriveReasoningSummaries(
	cacheId: string,
	markdown: string,
	done = false
): ReasoningSummary[] {
	const text = markdown ?? '';
	// Without a cache id there is no state to keep; the full build is the
	// documented streaming/non-streaming path, just without the incremental win.
	if (!cacheId) {
		return buildReasoningSummary(text, { streaming: !done });
	}

	const cached = previewStates.get(cacheId);
	// No summary was ever handed out for this reasoning: the finished build is
	// both cheaper (one pass) and exact (whole-corpus IDF, diversity repair over
	// every block, including the trailing line). Drop any progress — a preview
	// only scan, or drafts that were still held — so a later incremental run
	// starts at zero.
	if (done && (!cached || !cached.summaries.length)) {
		const state = cached ?? previewStateFor(cacheId);
		// A re-run of the same finished text must hand back the same array.
		if (state.builtSummaries && state.builtText === text) {
			return state.builtSummaries;
		}
		const summaries = buildReasoningSummary(text);
		Object.assign(state, createPreviewState());
		state.builtText = text;
		state.builtSummaries = summaries;
		return summaries;
	}

	const state = cached ?? previewStateFor(cacheId);
	processPreviewState(state, text);
	// After the scan: an edited/replaced text resets the state first, and the
	// blocks that just closed are then caught up in order.
	enableReasoningSummaries(state);
	if (done) {
		finishSummaryState(state, text);
	}

	return drainSummaryState(state);
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
	/** Title of the last closed block, held until the next block decides merging. */
	pendingTitle: string;
	/**
	 * A titleless block whose forward expansion is still open: the preview holds
	 * the previous title and shows the expanded one only when a title is found.
	 * The texts are the base block followed by the absorbed blocks.
	 */
	previewExpansion: {
		texts: string[];
		pendingBefore: string;
		/** Absorbed-token boundaries already re-derived and rejected. */
		attempted: Set<number>;
	} | null;
	/** Title of the last finalized block, safe to show. */
	lastFinalizedTitle: string;
	fence: FenceState;
	/**
	 * Prepared texts of the blocks that have closed, in order. A block is scored
	 * against the prefix that ends at itself, which never changes later. Kept
	 * before a summary consumer appears, so enabling it later replays the blocks.
	 */
	corpus: string[];
	/** True once `deriveReasoningSummaries` owns this state. */
	summariesEnabled: boolean;
	/** Number of corpus blocks that went through the summary pipeline. */
	processedBlocks: number;
	/**
	 * Base index of the titleless window currently being expanded, or -1. The
	 * window is rescanned from this block when another one closes.
	 */
	expansionBase: number;
	/**
	 * Absorbed-token boundaries this window already rejected. A rescan of the same
	 * region cannot title, so the derivation is skipped instead of repeated.
	 */
	expansionAttempts: Set<number>;
	/** Titles already final in this reasoning, for the diversity pass (S4). */
	chosenTitles: TitleBag[];
	/** Title terms of the previous draft, for the continuation anchor (S4). */
	priorTitleTerms: ReadonlySet<string>;
	/**
	 * Whole-corpus IDF for a finished build, or null to score each block against
	 * the prefix that ends at itself (the streaming invariant). The build shim
	 * sets it once; the incremental scan never does.
	 */
	sessionIdf: ContentIdf | null;
	/** The last draft, held until the next block decides whether it merges. */
	pendingDraft: SummaryDraft | null;
	/** Closed drafts not rendered yet: body extraction is deferred to the caller. */
	renderQueue: SummaryDraft[];
	/** Rendered summaries; returned by identity while nothing new closed. */
	summaries: ReasoningSummary[];
	/** Bodies already shown, so a restated sentence yields across blocks. */
	bodyContext: BodyContext;
	/** Text of the last finished build handed out, to keep its array identity. */
	builtText: string;
	/** The finished build itself; a call with the same text returns this array. */
	builtSummaries: ReasoningSummary[] | null;
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
		pendingTitle: '',
		lastFinalizedTitle: '',
		previewExpansion: null,
		fence: new FenceState(),
		corpus: [],
		summariesEnabled: false,
		processedBlocks: 0,
		expansionBase: -1,
		expansionAttempts: new Set(),
		chosenTitles: [],
		priorTitleTerms: EMPTY_TITLE_TERMS,
		sessionIdf: null,
		pendingDraft: null,
		renderQueue: [],
		summaries: [],
		bodyContext: { displayed: [] },
		builtText: '',
		builtSummaries: null
	};
}

function previewStateFor(cacheId: string): PreviewState {
	let state = previewStates.get(cacheId);
	if (!state) {
		state = createPreviewState();
		previewStates.set(cacheId, state);
		if (previewStates.size > PREVIEW_CACHE_LIMIT) {
			const oldest = previewStates.keys().next().value;
			if (oldest !== undefined) {
				previewStates.delete(oldest);
			}
		}
	}
	return state;
}

// The pending title can no longer receive a tail: its title is final.
function releasePreviewTitle(state: PreviewState): void {
	if (state.pendingTitle) {
		state.lastFinalizedTitle = state.pendingTitle;
		state.pendingTitle = '';
	}
}

// The pending block can no longer receive a tail: its title is final. A
// titleless window that is still open is concluded first: the finished text
// closes it, and a failure replays the absorbed blocks under their own titles.
function finalizePreviewTitle(state: PreviewState): void {
	if (state.previewExpansion) {
		resolvePreviewExpansion(state, true);
	}
	releasePreviewTitle(state);
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
	const fence = state.fence;
	for (const line of lines) {
		const trimmed = line.trim();
		fence.consume(trimmed);

		// A block ends at a blank line once it has reached its token target,
		// mirroring the block cut.
		if (!fence.active && trimmed === '' && state.tokens >= REASONING_SUMMARY_TOKEN_TARGET) {
			const completedText = prepareBlockText(markdown.slice(state.blockStart, offset).split('\n'));
			// The preview holds only the block that just closed: earlier blocks are
			// already shown and are never re-titled, so they cannot join the corpus.
			// One block is N = 1, whose IDF is the neutral constant.
			closePreviewBlock(state, completedText);
			// The summary builder computes this block here. A titleless window it
			// opens is rescanned when the next block closes, never after it has
			// been returned.
			recordClosedBlock(state, completedText);

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

// A block that just closed decides the preview title: hold it while the next
// block may still fold a short tail into it, release the previous one otherwise.
// A titleless prose block opens a forward window instead: the previous title
// stays on screen until the window either finds a title or is spent.
function closePreviewBlock(
	state: PreviewState,
	completedText: string,
	allowExpansion = true
): void {
	if (!completedText) {
		return;
	}
	if (state.previewExpansion) {
		state.previewExpansion.texts.push(completedText);
		resolvePreviewExpansion(state, false);
		return;
	}

	// The preview scores the block on its own: earlier blocks are already shown
	// and are never re-titled, so they cannot join its corpus.
	const selection = deriveReasoningSummaryTitle(completedText, buildContentIdf([completedText]));
	const candidate = selection.candidate;
	const tail = state.pendingTitle ? shortSummaryBlock(completedText, candidate) : null;
	if (!tail) {
		if (allowExpansion && !candidate.title && selection.prose) {
			state.previewExpansion = {
				texts: [completedText],
				pendingBefore: state.pendingTitle,
				attempted: new Set()
			};
			return;
		}
		// The previous block can no longer receive a tail: release its title and
		// hold this block's title until the next merge decision.
		finalizePreviewTitle(state);
		state.pendingTitle = candidate.title;
	}
}

/**
 * Drives the preview's titleless window. The preview scores the region with
 * `NEUTRAL_CONTENT_IDF`, matching the per-block title it would derive. A ready
 * window replaces the held title; a failed one replays the base and absorbed
 * blocks under the ordinary close rule, so the status line matches what the
 * blocks would have shown without expansion.
 */
function resolvePreviewExpansion(state: PreviewState, final: boolean): void {
	const expansion = state.previewExpansion;
	if (!expansion) {
		return;
	}
	if (expansion.texts.length < 2) {
		if (!final) {
			return;
		}
		state.previewExpansion = null;
		state.pendingTitle = expansion.pendingBefore;
		closePreviewBlock(state, expansion.texts[0], false);
		return;
	}

	const outcome = expandTitlelessBlock({
		blocks: expansion.texts,
		index: 0,
		contentIdfAt: () => NEUTRAL_CONTENT_IDF,
		context: { chosenTitles: [], priorTitleTerms: EMPTY_TITLE_TERMS },
		final,
		attempted: expansion.attempted
	});
	if (outcome.status === 'pending') {
		return;
	}

	state.previewExpansion = null;
	state.pendingTitle = expansion.pendingBefore;
	if (outcome.status === 'ready') {
		releasePreviewTitle(state);
		state.pendingTitle = outcome.selection.candidate.title;
		return;
	}
	for (const text of expansion.texts) {
		closePreviewBlock(state, text, false);
	}
}

/**
 * Records a closed block. The preview always needs its text (it titles the block
 * itself); the summary pipeline runs only once a summary consumer asked for it,
 * so a preview-only reasoning does not pay for titles and bodies it never shows.
 */
function recordClosedBlock(state: PreviewState, blockText: string): void {
	// An empty group (a run of blank lines) is not a document in the splitter's
	// corpus either.
	if (!blockText) {
		return;
	}

	state.corpus.push(blockText);
	if (!state.summariesEnabled) {
		return;
	}
	advanceSummaryState(state, false);
}

type SummaryStep = {
	/** Blocks this step settles: the base plus anything it absorbed. */
	consumed: number;
	/** The titleless window is still open; nothing was applied. */
	pending: boolean;
	/** The window spent its budget and must be replayed under the finish rules. */
	retry: boolean;
};

/** A block that settled without absorbing or holding anything. */
const SETTLED_STEP: SummaryStep = { consumed: 1, pending: false, retry: false };

/** Chosen-title bookkeeping for a block that just became a draft's anchor. */
function adoptTitle(state: PreviewState, title: string): void {
	state.chosenTitles.push(titleBag(title));
	state.priorTitleTerms = new Set(titleContentWordTerms(title));
}

/** A draft from a settled selection; the pool is kept for the diversity repair. */
function newDraft(
	blockText: string,
	selection: TitleSelection,
	contentIdf: ContentIdf
): SummaryDraft {
	return {
		blockText,
		candidate: selection.candidate,
		contentIdf,
		candidates: selection.candidates,
		fallback: selection.fallback
	};
}

/** A held draft that can no longer receive a tail is queued for rendering. */
function releasePendingDraft(state: PreviewState): void {
	if (state.pendingDraft) {
		state.renderQueue.push(state.pendingDraft);
		state.pendingDraft = null;
	}
}

/** The title decision for the block at `index`, plus the context it saw. */
function summarizeBlockAt(
	state: PreviewState,
	index: number
): {
	blockText: string;
	contentIdf: ContentIdf;
	selection: TitleSelection;
	context: TitleContext;
} {
	const blockText = state.corpus[index];
	// The block sees the prefix that ends at itself — the same corpus a
	// streaming call would give it — so later blocks can never re-title it.
	const contentIdf = summaryIdfAt(state, index + 1);
	const context: TitleContext = {
		chosenTitles: state.chosenTitles,
		priorTitleTerms: state.priorTitleTerms
	};
	const selection = deriveReasoningSummaryTitle(blockText, contentIdf, context);
	return { blockText, contentIdf, selection, context };
}

/**
 * A short titleless block folds into the previous draft's raw text; the draft
 * stays held and its title is untouched. Runs before expansion, so a tail that
 * already has a home is not delayed.
 */
function mergeShortTail(
	state: PreviewState,
	blockText: string,
	candidate: TitleCandidate
): boolean {
	const pending = state.pendingDraft;
	if (!pending?.candidate.title) {
		return false;
	}
	const tail = shortSummaryBlock(blockText, candidate);
	if (!tail || !canMergeIntoDraft(pending, tail)) {
		return false;
	}
	mergeIntoDraft(pending, tail);
	return true;
}

/**
 * Forward expansion of a titleless prose block; null when ineligible or when the
 * window failed on the finished text (the ordinary titleless path applies).
 * While `pending`, no state was touched, so the next call can rescan the window.
 */
function expandSummaryWindow(
	state: PreviewState,
	index: number,
	final: boolean,
	selection: TitleSelection,
	context: TitleContext
): SummaryStep | null {
	if (selection.candidate.title || !selection.prose) {
		return null;
	}
	if (state.expansionBase !== index) {
		state.expansionBase = index;
		state.expansionAttempts = new Set();
	}
	const expansion = expandTitlelessBlock({
		blocks: state.corpus,
		index,
		contentIdfAt: (end) => summaryIdfAt(state, end),
		context,
		final,
		attempted: state.expansionAttempts
	});
	if (expansion.status === 'pending') {
		return { consumed: expansion.consumed, pending: true, retry: false };
	}
	if (expansion.status === 'failed' && !final) {
		// The budget is spent: redo the window block by block, exactly as if
		// expansion had never been tried. `advanceSummaryState` replays it.
		return { consumed: expansion.consumed, pending: false, retry: true };
	}
	if (expansion.status !== 'ready') {
		return null;
	}
	// The region titles: it starts a new draft, and the draft held before it can
	// no longer receive a tail.
	releasePendingDraft(state);
	adoptTitle(state, expansion.selection.candidate.title);
	state.pendingDraft = newDraft(expansion.blockText, expansion.selection, expansion.contentIdf);
	return { consumed: expansion.consumed, pending: false, retry: false };
}

/**
 * Applies a block whose title decision is final. Two conditions merge it into a
 * held titled draft, in this order and mutually exclusive by construction:
 * 1. titleless prose (the short-tail case): it has no title to show, so the body
 *    reads under the previous one;
 * 2. contentful title with no content behind it (the contentless case): the
 *    title is the block's only sentence, so a draft of its own would render a
 *    title over an empty body. It joins the previous draft the same way, with
 *    the same merge budget; without a target it keeps the old standalone
 *    rendering (title, body ""), because dropping a title nobody can replace
 *    would lose the only text the block has.
 * A titleless draft cannot be a target, so it is queued.
 */
function settleSummaryBlock(
	state: PreviewState,
	blockText: string,
	selection: TitleSelection,
	contentIdf: ContentIdf
): void {
	const candidate = selection.candidate;
	if (!candidate.title && selection.prose) {
		const target = state.pendingDraft ?? state.renderQueue.at(-1) ?? null;
		if (canMergeIntoDraft(target, blockText)) {
			mergeIntoDraft(target!, blockText);
			return;
		}
	}

	// The complement of the branch above: a titled prose block whose own title is
	// all it says. Structural selections stay out (`selection.prose` is false):
	// a heading or label line is a complete draft even with no body under it.
	if (candidate.title && selection.prose && contentlessSummaryBlock(blockText, candidate)) {
		const target = state.pendingDraft ?? state.renderQueue.at(-1) ?? null;
		if (canMergeIntoDraft(target, blockText)) {
			mergeIntoDraft(target!, blockText);
			return;
		}
	}

	releasePendingDraft(state);
	if (candidate.title) {
		adoptTitle(state, candidate.title);
		state.pendingDraft = newDraft(blockText, selection, contentIdf);
		return;
	}
	state.priorTitleTerms = EMPTY_TITLE_TERMS;
	state.renderQueue.push(newDraft(blockText, selection, contentIdf));
}

/**
 * Turns the block at `index` into a draft: short-tail merge, forward expansion,
 * then the settled title/titleless path. The state carries the prefix IDF, the
 * chosen titles and the previous title's terms, so each block is seen once.
 * `allowExpansion` is cleared only when a batch call re-settles a spent window:
 * that caller has no state to replay, so the block takes the ordinary path.
 */
function processSummaryBlock(
	state: PreviewState,
	index: number,
	final: boolean,
	allowExpansion = true
): SummaryStep {
	const { blockText, contentIdf, selection, context } = summarizeBlockAt(state, index);
	if (mergeShortTail(state, blockText, selection.candidate)) {
		return SETTLED_STEP;
	}
	if (allowExpansion) {
		const expanded = expandSummaryWindow(state, index, final, selection, context);
		if (expanded) {
			return expanded;
		}
	}
	settleSummaryBlock(state, blockText, selection, contentIdf);
	return SETTLED_STEP;
}

/**
 * Advances over every corpus block that is not settled yet. A pending expansion
 * leaves `processedBlocks` on its base so the next closed block rescans the
 * window; a ready one consumes every absorbed block. A spent window (`retry`) is
 * replayed block by block, or settled in one pass when `replaySpent` is false.
 */
function advanceSummaryState(state: PreviewState, final: boolean, replaySpent = true): void {
	while (state.processedBlocks < state.corpus.length) {
		const index = state.processedBlocks;
		const step = processSummaryBlock(state, index, final);
		if (step.pending) {
			return;
		}
		if (step.retry) {
			if (replaySpent) {
				replaySummaryRange(state, index);
			} else {
				// No state to carry over: the block settles under the ordinary
				// titleless path, exactly as a single batch pass did.
				processSummaryBlock(state, index, final, false);
				state.processedBlocks = index + 1;
			}
			continue;
		}
		state.processedBlocks = index + step.consumed;
	}
}

/**
 * Replays a spent expansion window: the base block takes the ordinary titleless
 * path, then each absorbed block is processed in order and may open a window of
 * its own. The budget already bounded the range, so the loop cannot run away.
 */
function replaySummaryRange(state: PreviewState, start: number): void {
	state.processedBlocks = start;
	while (state.processedBlocks < state.corpus.length) {
		const step = processSummaryBlock(state, state.processedBlocks, true);
		if (step.pending) {
			return;
		}
		state.processedBlocks += step.consumed;
	}
}

/**
 * Hands the state to the summary builder and catches up with the blocks that
 * closed while only the preview was reading it. Every block still sees the same
 * prefix it closed with, so a late start produces the same titles.
 */
function enableReasoningSummaries(state: PreviewState): void {
	state.summariesEnabled = true;
	advanceSummaryState(state, false);
}

/**
 * Closes the reasoning: the held-back trailing line joins its block, the held
 * draft is released, and not-yet-returned blocks get the diversity repair.
 * Already returned summaries are not touched — the repair only moves a title
 * that has not been shown.
 */
function finishSummaryState(state: PreviewState, markdown: string): void {
	// The line after the last newline was never scanned: it belongs to the last
	// block and may close a fence the scan left open.
	const rest = markdown.slice(state.length);
	if (rest) {
		state.fence.consume(rest.trim());
	}
	if (state.length < markdown.length) {
		state.length = markdown.length;
		state.tail = markdown.slice(Math.max(markdown.length - PREVIEW_STATE_TAIL, 0), markdown.length);
	}

	// The whole trailing group: streaming counted only its terminated lines, a
	// finished reasoning also counts the line after the last newline.
	const blockText = prepareBlockText(markdown.slice(state.blockStart).split('\n'));
	recordClosedBlock(state, blockText);
	// A titleless window that was still open absorbs to the end of the text and
	// is concluded here; a window that had no text behind it takes the ordinary
	// titleless path.
	advanceSummaryState(state, true);

	// While streaming, a titled draft may still receive a tail from the next
	// block; the finished text ends that possibility.
	releasePendingDraft(state);

	// The blocks still in the queue are the only ones not shown yet: the repair
	// may move their titles, and reads the returned ones as fixed reference.
	const fixedTitles = state.summaries
		.filter((summary) => summary.title)
		.map((summary) => titleBag(summary.title));
	repairTitleDiversity(state.renderQueue, fixedTitles);

	state.blockStart = markdown.length;
	state.tokens = 0;
}

/**
 * Renders the drafts that closed since the last call, in order, against the
 * bodies already shown. The array handed out earlier is never mutated: a tick
 * that adds a summary gets a new list, a tick that adds none keeps the old one.
 */
function drainSummaryState(state: PreviewState): ReasoningSummary[] {
	if (!state.renderQueue.length) {
		return state.summaries;
	}

	let summaries = state.summaries;
	for (const draft of state.renderQueue) {
		const summary = renderSummaryDraft(draft, REASONING_SUMMARY_TOKEN_LIMIT, state.bodyContext);
		if (!summary) {
			continue;
		}
		if (summaries === state.summaries) {
			summaries = state.summaries.slice();
		}
		summaries.push(summary);
	}

	state.renderQueue = [];
	state.summaries = summaries;
	return summaries;
}
