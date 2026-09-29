export type ReplacementChunk = {
	target?: unknown;
	replacement?: unknown;
};

export type DiffSegment = { text: string; changed: boolean };
export type DiffRow = {
	type: 'file' | 'hunk' | 'addition' | 'deletion' | 'meta' | 'context';
	prefix: string;
	content: string;
	oldNumber: number | null;
	newNumber: number | null;
	segments: DiffSegment[];
};

export function parseDiffRows(code: string): DiffRow[] {
	let oldNumber = 0;
	let newNumber = 0;
	let oldRemaining = 0;
	let newRemaining = 0;
	const rows = code.split('\n').map((text): DiffRow => {
		const row: DiffRow = {
			type: 'context',
			prefix: '',
			content: text,
			oldNumber: null,
			newNumber: null,
			segments: []
		};
		const hunk = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
		const inHunk = oldRemaining > 0 || newRemaining > 0;
		if (hunk) {
			row.type = 'hunk';
			oldNumber = Number(hunk[1]);
			newNumber = Number(hunk[3]);
			oldRemaining = Number(hunk[2] ?? 1);
			newRemaining = Number(hunk[4] ?? 1);
		} else if (
			text.startsWith('diff ') ||
			(!inHunk &&
				/^(index |---(?:\s|$)|\+\+\+(?:\s|$)|(?:old|new|deleted file|new file) mode |(?:dis)?similarity index |(?:rename|copy) (?:from|to) )/.test(
					text
				))
		) {
			row.type = 'file';
			oldRemaining = newRemaining = 0;
		} else if (text.startsWith('@@')) {
			// Incomplete streaming headers must not inherit the preceding hunk's numbers.
			row.type = 'hunk';
			oldRemaining = newRemaining = 0;
		} else if (text.startsWith('\\')) {
			row.type = 'meta';
		} else {
			if (text.startsWith('+')) row.type = 'addition';
			if (text.startsWith('-')) row.type = 'deletion';
			if (/^[+\- ]/.test(text)) {
				row.prefix = text[0];
				row.content = text.slice(1);
			}
			if (inHunk && (row.prefix || text === '')) {
				if (row.type !== 'addition' && oldRemaining > 0) {
					row.oldNumber = oldNumber++;
					oldRemaining--;
				}
				if (row.type !== 'deletion' && newRemaining > 0) {
					row.newNumber = newNumber++;
					newRemaining--;
				}
			}
		}
		row.segments = [{ text: row.content, changed: false }];
		return row;
	});

	for (let i = 0; i < rows.length; ) {
		const removed: DiffRow[] = [];
		const added: DiffRow[] = [];
		while (rows[i]?.type === 'deletion' || rows[i]?.type === 'addition') {
			(rows[i].type === 'deletion' ? removed : added).push(rows[i++]);
		}
		if (removed.length === added.length) {
			removed.forEach((oldRow, index) => emphasizePair(oldRow, added[index]));
		}
		i++;
	}
	return rows;
}

function emphasizePair(oldRow: DiffRow, newRow: DiffRow) {
	if (
		oldRow.content === newRow.content ||
		Math.max(oldRow.content.length, newRow.content.length) >= 1024
	)
		return;
	const oldText = Array.from(oldRow.content);
	const newText = Array.from(newRow.content);
	let start = 0;
	while (start < Math.min(oldText.length, newText.length) && oldText[start] === newText[start])
		start++;
	let oldEnd = oldText.length;
	let newEnd = newText.length;
	while (oldEnd > start && newEnd > start && oldText[oldEnd - 1] === newText[newEnd - 1]) {
		oldEnd--;
		newEnd--;
	}
	// ponytail: like computer's Git view, emphasize one changed middle per paired line.
	// Use a token diff if multiple independent edits need separate spans.
	for (const [row, text, end] of [
		[oldRow, oldText, oldEnd],
		[newRow, newText, newEnd]
	] as const) {
		row.segments = [
			{ text: text.slice(0, start).join(''), changed: false },
			{ text: text.slice(start, end).join(''), changed: true },
			{ text: text.slice(end).join(''), changed: false }
		].filter((segment) => segment.text.length > 0);
	}
}

// Split file content into diff lines. A single trailing newline is treated as
// a line terminator rather than an extra empty line.
function splitDiffLines(text: string): string[] {
	if (text === '') return [];
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') lines.pop();
	return lines;
}

type LineOp = 'context' | 'delete' | 'insert';

// Above this many table cells the quadratic LCS is skipped and the middle is
// emitted as a plain delete/insert block instead. Untouched lines are still
// stripped by the common prefix/suffix pass, so this only affects edits with
// many interleaved changes in a very large replaced region.
const LCS_CELL_LIMIT = 4_000_000;

function diffMiddle(
	oldLines: string[],
	newLines: string[],
	emit: (type: LineOp, line: string) => void
) {
	const n = oldLines.length;
	const m = newLines.length;
	if (n === 0) {
		for (const line of newLines) emit('insert', line);
		return;
	}
	if (m === 0) {
		for (const line of oldLines) emit('delete', line);
		return;
	}
	if ((n + 1) * (m + 1) > LCS_CELL_LIMIT) {
		for (const line of oldLines) emit('delete', line);
		for (const line of newLines) emit('insert', line);
		return;
	}

	const width = m + 1;
	const dp = new Uint32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i * width + j] =
				oldLines[i] === newLines[j]
					? dp[(i + 1) * width + j + 1] + 1
					: Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1]);
		}
	}

	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (oldLines[i] === newLines[j]) {
			emit('context', oldLines[i]);
			i++;
			j++;
		} else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
			emit('delete', oldLines[i]);
			i++;
		} else {
			emit('insert', newLines[j]);
			j++;
		}
	}
	while (i < n) emit('delete', oldLines[i++]);
	while (j < m) emit('insert', newLines[j++]);
}

const LINE_PREFIX: Record<LineOp, string> = { context: ' ', delete: '-', insert: '+' };

type DiffOp = { type: LineOp; line: string };
type FoldedOp = DiffOp | { type: 'fold'; hidden: number };

// How many unchanged lines to keep on each side of a change before folding the
// rest away.
const CONTEXT_LINES = 3;
const FOLD_SEPARATOR = '@@ ... ... @@';

// Collapse long runs of unchanged lines: keep a few lines next to a change and
// replace the remainder with an `@@` marker. Runs at the start or end of the
// replaced region are simply trimmed, with no marker: there is no change on the
// other side for the marker to point at. Because the diff is built from the
// tool's find/replace pairs the elided count is exact.
function foldContext(ops: DiffOp[], context: number): FoldedOp[] {
	const out: FoldedOp[] = [];
	const isChange = (op: DiffOp) => op.type !== 'context';
	let i = 0;
	while (i < ops.length) {
		if (isChange(ops[i])) {
			out.push(ops[i++]);
			continue;
		}

		let j = i;
		while (j < ops.length && !isChange(ops[j])) j++;
		const run = ops.slice(i, j);

		if (i === 0) {
			// Leading context: keep the lines closest to the first change.
			out.push(...run.slice(Math.max(0, run.length - context)));
		} else if (j === ops.length) {
			// Trailing context: keep the lines closest to the last change.
			out.push(...run.slice(0, context));
		} else if (run.length <= context * 2) {
			out.push(...run);
		} else {
			out.push(...run.slice(0, context));
			out.push({ type: 'fold', hidden: run.length - context * 2 });
			out.push(...run.slice(run.length - context));
		}
		i = j;
	}
	return out;
}

/**
 * Build a real line-level diff from an Open Terminal `replace_file_content`
 * call.
 *
 * The tool only exposes the find/replace pairs to the client, so the diff is
 * computed between each chunk's `target` and `replacement`. Lines that are
 * identical on both sides are emitted as context rows (and never as an
 * add/remove pair), while only genuinely added or removed lines get a `+`/`-`
 * prefix. Unchanged runs between two changes are folded into `@@ ... n ... @@`
 * markers, while leading/trailing runs are just trimmed. Hunk headers with line
 * numbers are intentionally omitted: the tool's `start_line` is only a search
 * hint, so we cannot know the file's real line numbers.
 */
export function buildReplacementDiff(path: string, replacements: unknown): string {
	if (!Array.isArray(replacements)) return '';

	const chunks = replacements.filter(
		(chunk): chunk is ReplacementChunk => typeof chunk === 'object' && chunk !== null
	);
	if (chunks.length === 0) return '';

	const body: string[] = [];
	let emittedChunk = false;
	for (const chunk of chunks) {
		const target = typeof chunk.target === 'string' ? chunk.target : '';
		const replacement = typeof chunk.replacement === 'string' ? chunk.replacement : '';
		if (!target && !replacement) continue;

		const oldLines = splitDiffLines(target);
		const newLines = splitDiffLines(replacement);

		// Keep a shared prefix/suffix as context so unchanged, merely-copied
		// lines are never rendered as if they had been edited.
		let prefix = 0;
		while (
			prefix < oldLines.length &&
			prefix < newLines.length &&
			oldLines[prefix] === newLines[prefix]
		) {
			prefix++;
		}
		let suffix = 0;
		while (
			suffix < oldLines.length - prefix &&
			suffix < newLines.length - prefix &&
			oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
		) {
			suffix++;
		}

		const ops: DiffOp[] = [];
		for (let k = 0; k < prefix; k++) ops.push({ type: 'context', line: oldLines[k] });
		diffMiddle(
			oldLines.slice(prefix, oldLines.length - suffix),
			newLines.slice(prefix, newLines.length - suffix),
			(type, line) => ops.push({ type, line })
		);
		for (let k = suffix - 1; k >= 0; k--)
			ops.push({ type: 'context', line: oldLines[oldLines.length - 1 - k] });

		if (!ops.some((op) => op.type !== 'context')) continue;
		if (emittedChunk) body.push(FOLD_SEPARATOR);
		emittedChunk = true;

		for (const op of foldContext(ops, CONTEXT_LINES)) {
			if (op.type === 'fold') {
				body.push(`@@ ... ${op.hidden} ... @@`);
			} else {
				body.push(`${LINE_PREFIX[op.type]}${op.line}`);
			}
		}
	}

	if (!emittedChunk) return '';

	const lines: string[] = [];
	if (path) {
		lines.push(`--- ${path}`, `+++ ${path}`);
	}
	lines.push(...body);
	return lines.join('\n');
}
