/** Line-level diff viewer for agent edits: hand-rolled LCS line diff with
 *  intra-line word highlighting. Pure/presentational, no dependencies. */

import { useMemo, type CSSProperties } from 'react';

export interface DiffViewProps {
  before: string;
  after: string;
  path: string;
}

export type DiffOp =
  | { kind: 'context'; beforeLine: number; afterLine: number; text: string }
  | { kind: 'removed'; beforeLine: number; text: string }
  | { kind: 'added'; afterLine: number; text: string };

export interface WordSeg {
  text: string;
  changed: boolean;
}

export interface DiffRow {
  kind: 'context' | 'removed' | 'added';
  beforeLine: number | null;
  afterLine: number | null;
  segments: WordSeg[];
}

// A full LCS table costs (a+1)*(b+1)*4 bytes, so past this budget the diff
// switches to unique-line anchors instead of allocating a giant table.
const MAX_TABLE_CELLS = 4_000_000;
const MAX_WORD_CELLS = 250_000;
const MAX_ROWS = 6000;

// Palette tints: --ok / --err at low alpha (inline styles cannot alpha-blend
// a var(), so the rgba values duplicate the design-token hex channels).
const ROW_ADD_BG = 'rgba(63, 206, 139, 0.10)';
const ROW_DEL_BG = 'rgba(240, 97, 109, 0.10)';
const WORD_ADD_BG = 'rgba(63, 206, 139, 0.32)';
const WORD_DEL_BG = 'rgba(240, 97, 109, 0.32)';

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: DiffOp[] = [];
  diffMiddle(a, 0, a.length, b, 0, b.length, out);
  return out;
}

function diffMiddle(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  out: DiffOp[],
): void {
  if (aLo === aHi) {
    for (let j = bLo; j < bHi; j++) out.push({ kind: 'added', afterLine: j + 1, text: b[j] });
    return;
  }
  if (bLo === bHi) {
    for (let i = aLo; i < aHi; i++) out.push({ kind: 'removed', beforeLine: i + 1, text: a[i] });
    return;
  }
  let pre = 0;
  while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
  let suf = 0;
  while (suf < aHi - aLo - pre && suf < bHi - bLo - pre && a[aHi - 1 - suf] === b[bHi - 1 - suf]) suf++;
  for (let k = 0; k < pre; k++) {
    out.push({ kind: 'context', beforeLine: aLo + k + 1, afterLine: bLo + k + 1, text: a[aLo + k] });
  }
  const mALo = aLo + pre;
  const mAHi = aHi - suf;
  const mBLo = bLo + pre;
  const mBHi = bHi - suf;
  const an = mAHi - mALo;
  const bn = mBHi - mBLo;
  if (an > 0 && bn > 0) {
    if (an * bn <= MAX_TABLE_CELLS) lcsEmit(a, mALo, mAHi, b, mBLo, mBHi, out);
    else anchorEmit(a, mALo, mAHi, b, mBLo, mBHi, out);
  } else if (an > 0) {
    for (let i = mALo; i < mAHi; i++) out.push({ kind: 'removed', beforeLine: i + 1, text: a[i] });
  } else {
    for (let j = mBLo; j < mBHi; j++) out.push({ kind: 'added', afterLine: j + 1, text: b[j] });
  }
  for (let k = 0; k < suf; k++) {
    out.push({ kind: 'context', beforeLine: mAHi + k + 1, afterLine: mBHi + k + 1, text: a[mAHi + k] });
  }
}

function lcsEmit(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  out: DiffOp[],
): void {
  const an = aHi - aLo;
  const bn = bHi - bLo;
  const w = bn + 1;
  const dp = new Uint32Array((an + 1) * w);
  for (let i = an - 1; i >= 0; i--) {
    const line = a[aLo + i];
    const row = i * w;
    const below = row + w;
    for (let j = bn - 1; j >= 0; j--) {
      dp[row + j] = line === b[bLo + j] ? dp[below + j + 1] + 1 : Math.max(dp[below + j], dp[row + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < an && j < bn) {
    if (a[aLo + i] === b[bLo + j]) {
      out.push({ kind: 'context', beforeLine: aLo + i + 1, afterLine: bLo + j + 1, text: a[aLo + i] });
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      // Ties break toward "removed" so a change block lists old lines first.
      out.push({ kind: 'removed', beforeLine: aLo + i + 1, text: a[aLo + i] });
      i++;
    } else {
      out.push({ kind: 'added', afterLine: bLo + j + 1, text: b[bLo + j] });
      j++;
    }
  }
  while (i < an) {
    out.push({ kind: 'removed', beforeLine: aLo + i + 1, text: a[aLo + i] });
    i++;
  }
  while (j < bn) {
    out.push({ kind: 'added', afterLine: bLo + j + 1, text: b[bLo + j] });
    j++;
  }
}

// Patience-style fallback for huge changed regions: lines unique in both
// ranges become anchors (kept monotonic via a longest increasing
// subsequence), and the gaps between anchors recurse.
function anchorEmit(
  a: string[],
  aLo: number,
  aHi: number,
  b: string[],
  bLo: number,
  bHi: number,
  out: DiffOp[],
): void {
  const countA = new Map<string, number>();
  for (let i = aLo; i < aHi; i++) countA.set(a[i], (countA.get(a[i]) ?? 0) + 1);
  const uniqueB = new Map<string, number>();
  const seenB = new Set<string>();
  for (let j = bLo; j < bHi; j++) {
    if (seenB.has(b[j])) {
      uniqueB.delete(b[j]);
      continue;
    }
    seenB.add(b[j]);
    uniqueB.set(b[j], j);
  }
  const pairs: Array<[number, number]> = [];
  for (let i = aLo; i < aHi; i++) {
    if (countA.get(a[i]) !== 1) continue;
    const j = uniqueB.get(a[i]);
    if (j !== undefined) pairs.push([i, j]);
  }
  const keep = longestIncreasingIndices(pairs.map((p) => p[1]));
  if (keep.length === 0) {
    for (let i = aLo; i < aHi; i++) out.push({ kind: 'removed', beforeLine: i + 1, text: a[i] });
    for (let j = bLo; j < bHi; j++) out.push({ kind: 'added', afterLine: j + 1, text: b[j] });
    return;
  }
  let curA = aLo;
  let curB = bLo;
  for (const idx of keep) {
    const [ai, bi] = pairs[idx];
    diffMiddle(a, curA, ai, b, curB, bi, out);
    out.push({ kind: 'context', beforeLine: ai + 1, afterLine: bi + 1, text: a[ai] });
    curA = ai + 1;
    curB = bi + 1;
  }
  diffMiddle(a, curA, aHi, b, curB, bHi, out);
}

function longestIncreasingIndices(values: number[]): number[] {
  const tails: number[] = [];
  const prev = new Array<number>(values.length).fill(-1);
  for (let i = 0; i < values.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[tails[mid]] < values[i]) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i);
    else tails[lo] = i;
  }
  const out: number[] = [];
  let idx = tails.length === 0 ? -1 : tails[tails.length - 1];
  while (idx >= 0) {
    out.push(idx);
    idx = prev[idx];
  }
  return out.reverse();
}

const WORD_RE = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;

/** Word-level diff for one changed line pair. Returns null when the token
 *  product is too large to be worth a table; callers fall back to a plain
 *  full-line tint. */
export function diffWords(
  beforeLine: string,
  afterLine: string,
): { before: WordSeg[]; after: WordSeg[] } | null {
  if (beforeLine === afterLine) {
    const seg: WordSeg = { text: beforeLine, changed: false };
    return { before: [seg], after: [{ ...seg }] };
  }
  const a = beforeLine.match(WORD_RE) ?? [];
  const b = afterLine.match(WORD_RE) ?? [];
  if (a.length === 0 || b.length === 0 || a.length * b.length > MAX_WORD_CELLS) return null;
  const w = b.length + 1;
  const dp = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const beforeSegs: WordSeg[] = [];
  const afterSegs: WordSeg[] = [];
  const push = (segs: WordSeg[], text: string, changed: boolean) => {
    const last = segs[segs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else segs.push({ text, changed });
  };
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(beforeSegs, a[i], false);
      push(afterSegs, b[j], false);
      i++;
      j++;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
      push(beforeSegs, a[i], true);
      i++;
    } else {
      push(afterSegs, b[j], true);
      j++;
    }
  }
  while (i < a.length) {
    push(beforeSegs, a[i], true);
    i++;
  }
  while (j < b.length) {
    push(afterSegs, b[j], true);
    j++;
  }
  return { before: beforeSegs, after: afterSegs };
}

/** Flattens ops into renderable rows, pairing the k-th removed line with the
 *  k-th added line of the same change block for intra-line highlighting. */
export function buildDiffRows(ops: DiffOp[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.kind === 'context') {
      rows.push({
        kind: 'context',
        beforeLine: op.beforeLine,
        afterLine: op.afterLine,
        segments: [{ text: op.text, changed: false }],
      });
      i++;
      continue;
    }
    const removed: Array<Extract<DiffOp, { kind: 'removed' }>> = [];
    const added: Array<Extract<DiffOp, { kind: 'added' }>> = [];
    while (i < ops.length) {
      const o = ops[i];
      if (o.kind === 'context') break;
      if (o.kind === 'removed') removed.push(o);
      else added.push(o);
      i++;
    }
    const paired = Math.min(removed.length, added.length);
    removed.forEach((o, k) => {
      const words = k < paired ? diffWords(o.text, added[k].text) : null;
      rows.push({
        kind: 'removed',
        beforeLine: o.beforeLine,
        afterLine: null,
        segments: words?.before ?? [{ text: o.text, changed: false }],
      });
    });
    added.forEach((o, k) => {
      const words = k < paired ? diffWords(removed[k].text, o.text) : null;
      rows.push({
        kind: 'added',
        beforeLine: null,
        afterLine: o.afterLine,
        segments: words?.after ?? [{ text: o.text, changed: false }],
      });
    });
  }
  return rows;
}

const containerStyle: CSSProperties = {
  border: '1px solid var(--border-0)',
  borderRadius: 'var(--radius-m)',
  background: 'var(--bg-1)',
  overflow: 'hidden',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  lineHeight: 1.5,
};

const headStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--sp-3)',
  padding: '6px var(--sp-3)',
  borderBottom: '1px solid var(--border-0)',
  background: 'var(--bg-2)',
  fontFamily: 'var(--font-sans)',
};

const pathStyle: CSSProperties = {
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: 'var(--text-1)',
};

const statsStyle: CSSProperties = {
  display: 'inline-flex',
  gap: 'var(--sp-2)',
  flexShrink: 0,
  fontWeight: 600,
};

const scrollStyle: CSSProperties = { overflowX: 'auto' };

const tableStyle: CSSProperties = { borderCollapse: 'collapse', width: '100%' };

const numStyle: CSSProperties = {
  width: '1%',
  minWidth: '4ch',
  padding: '0 8px',
  textAlign: 'right',
  verticalAlign: 'top',
  color: 'var(--text-2)',
  userSelect: 'none',
  borderRight: '1px solid var(--border-0)',
};

const signStyle: CSSProperties = {
  width: '2ch',
  textAlign: 'center',
  verticalAlign: 'top',
  userSelect: 'none',
};

const codeStyle: CSSProperties = {
  width: '99%',
  padding: '0 12px',
  whiteSpace: 'pre',
  verticalAlign: 'top',
};

const truncatedStyle: CSSProperties = {
  padding: '6px var(--sp-3)',
  color: 'var(--text-2)',
  borderTop: '1px solid var(--border-0)',
  fontFamily: 'var(--font-sans)',
};

function DiffRowView({ row }: { row: DiffRow }) {
  const isEmpty = row.segments.every((s) => s.text === '');
  const background = row.kind === 'added' ? ROW_ADD_BG : row.kind === 'removed' ? ROW_DEL_BG : 'transparent';
  const wordBg = row.kind === 'added' ? WORD_ADD_BG : WORD_DEL_BG;
  const sign = row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : '';
  const signColor =
    row.kind === 'added' ? 'var(--ok)' : row.kind === 'removed' ? 'var(--err)' : 'var(--text-2)';
  return (
    <tr className={`diff-row diff-row--${row.kind}`} style={{ background }}>
      <td className="diff-num diff-num--before" style={numStyle} aria-hidden="true">
        {row.beforeLine ?? ''}
      </td>
      <td className="diff-num diff-num--after" style={numStyle} aria-hidden="true">
        {row.afterLine ?? ''}
      </td>
      <td className="diff-sign" style={{ ...signStyle, color: signColor }} aria-hidden="true">
        {sign}
      </td>
      <td className="diff-code" style={codeStyle}>
        {isEmpty
          ? ' '
          : row.segments.map((s, k) =>
              s.changed ? (
                <span key={k} className="diff-word" style={{ background: wordBg, borderRadius: 2 }}>
                  {s.text}
                </span>
              ) : (
                s.text
              ),
            )}
      </td>
    </tr>
  );
}

interface DiffModel {
  rows: DiffRow[];
  total: number;
  addedCount: number;
  removedCount: number;
}

export function DiffView({ before, after, path }: DiffViewProps) {
  const model = useMemo<DiffModel>(() => {
    const ops = diffLines(before, after);
    let addedCount = 0;
    let removedCount = 0;
    for (const op of ops) {
      if (op.kind === 'added') addedCount++;
      else if (op.kind === 'removed') removedCount++;
    }
    const all = buildDiffRows(ops);
    return {
      rows: all.length > MAX_ROWS ? all.slice(0, MAX_ROWS) : all,
      total: all.length,
      addedCount,
      removedCount,
    };
  }, [before, after]);

  return (
    <div className="diff-view" style={containerStyle}>
      <div className="diff-head" style={headStyle}>
        <span className="diff-path" style={pathStyle} title={path}>
          {path}
        </span>
        <span className="diff-stats" style={statsStyle}>
          {model.addedCount === 0 && model.removedCount === 0 ? (
            <span style={{ color: 'var(--text-2)' }}>No changes</span>
          ) : (
            <>
              <span style={{ color: 'var(--ok)' }}>+{model.addedCount}</span>
              <span style={{ color: 'var(--err)' }}>-{model.removedCount}</span>
            </>
          )}
        </span>
      </div>
      {model.rows.length === 0 ? (
        <div className="empty-state">
          <p>Both versions of {path} are empty.</p>
        </div>
      ) : (
        <div className="diff-scroll" style={scrollStyle}>
          <table className="diff-table" style={tableStyle} aria-label={`Changes in ${path}`}>
            <tbody>
              {model.rows.map((row, k) => (
                <DiffRowView key={k} row={row} />
              ))}
              {model.total > model.rows.length && (
                <tr className="diff-row diff-row--truncated">
                  <td colSpan={4} style={truncatedStyle}>
                    Showing first {model.rows.length} of {model.total} diff rows.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
