// HTML adaptation of BULD (Cobena, Abiteboul, Marian, ICDE 2002).
// See BULD.md for deliberate deviations, score semantics, and delta addressing.
import { diffWords } from 'diff';
import { htmlToTree } from '../parse/tree';
import type { DiffResult, TreeNode, TreeRep } from './diff-interfaces';
import { Differ } from './differ';
import { MAX_RUNS, shortenRun, type PreviewRun } from './preview';

interface Address { path: string; parent: string; index: number }
interface Value { tag: string; text?: string }
export type BuldEdit =
  | { type: 'insert'; to: Address; value: Value }
  | { type: 'delete'; from: Address; value: Value }
  | { type: 'update'; from: Address; to: Address; before: string; after: string;
      words?: { op: 'equal' | 'insert' | 'delete'; text: string }[] }
  | { type: 'move'; from: Address; to: Address };
export interface BuldSummary {
  oldNodes: number;
  newNodes: number;
  matchedNodes: number;
  unchangedNodes: number;
}
export interface BuldDiff {
  edits: BuldEdit[];
  summary: BuldSummary;
}
interface IndexedNode {
  node: TreeNode;
  parent: number;
  position: number;
  children: number[];
  signature: number;
  weight: number;
}
interface Matching {
  old: IndexedNode[];
  next: IndexedNode[];
  forward: Map<number, number>;
  backward: Map<number, number>;
  summary: BuldSummary;
}

// Interning canonical tuples gives collision-free signatures, shared across the
// two trees. Child signature IDs avoid serializing entire subtrees at each node.
function indexTree(root: TreeNode, signatures: Map<string, number>): IndexedNode[] {
  const nodes: IndexedNode[] = [];
  const pending = [{ node: root, parent: -1, position: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    const id = nodes.length;
    nodes.push({ ...item, children: [], signature: 0, weight: 1 });
    if (item.parent >= 0) nodes[item.parent]!.children.push(id);
    for (let i = item.node.children.length - 1; i >= 0; i--) {
      pending.push({ node: item.node.children[i]!, parent: id, position: i });
    }
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const entry = nodes[i]!;
    const key = JSON.stringify([entry.node.tag, entry.node.text ?? '',
      entry.children.map(child => nodes[child]!.signature)]);
    if (!signatures.has(key)) signatures.set(key, signatures.size + 1);
    entry.signature = signatures.get(key)!;
    entry.weight = 1 + entry.children.reduce((sum, child) => sum + nodes[child]!.weight, 0);
  }
  return nodes;
}

function group<T>(values: T[], key: (value: T) => string | number): Map<string | number, T[]> {
  const result = new Map<string | number, T[]>();
  for (const value of values) {
    const k = key(value);
    const bucket = result.get(k);
    if (bucket) bucket.push(value);
    else result.set(k, [value]);
  }
  return result;
}

function matchTrees(oldRep: TreeRep, newRep: TreeRep): Matching {
  const signatures = new Map<string, number>();
  const old = indexTree(oldRep.root, signatures);
  const next = indexTree(newRep.root, signatures);
  const forward = new Map<number, number>();
  const backward = new Map<number, number>();
  const pair = (a: number, b: number): boolean => {
    if (forward.has(a) || backward.has(b) || old[a]!.node.tag !== next[b]!.node.tag) return false;
    forward.set(a, b);
    backward.set(b, a);
    return true;
  };
  pair(0, 0);

  // HTML IDs are hints, unlike authoritative DTD IDs in XML. Duplicate IDs are
  // ignored and changing an ID does not by itself constitute a content change.
  const ids = (nodes: IndexedNode[]) => group(nodes.map((_, i) => i)
    .filter(i => Boolean(nodes[i]!.node.attrs?.id)), i => nodes[i]!.node.attrs!.id!);
  const oldIds = ids(old), newIds = ids(next);
  for (const [id, candidates] of oldIds) {
    const targets = newIds.get(id);
    if (candidates.length === 1 && targets?.length === 1) pair(candidates[0]!, targets[0]!);
  }

  const propagateUp = (a: number, b: number) => {
    // Larger anchors may justify matching more ancestors. This bound is an
    // adaptation, not the paper's document-weight-dependent tuning formula.
    const limit = Math.floor(Math.log2(next[b]!.weight));
    for (let depth = 0; depth < limit; depth++) {
      a = old[a]!.parent;
      b = next[b]!.parent;
      if (a < 0 || b < 0 || !pair(a, b)) break;
    }
  };
  for (const [a, b] of [...forward]) propagateUp(a, b);

  const bySignature = group(old.map((_, i) => i).slice(1), i => old[i]!.signature);
  const local = new Map<string, number[]>();
  for (let a = 1; a < old.length; a++) {
    const key = `${old[a]!.parent}:${old[a]!.signature}`;
    const bucket = local.get(key);
    if (bucket) bucket.push(a);
    else local.set(key, [a]);
  }
  // Lazy cursors discard consumed candidates without repeatedly scanning them.
  const cursors = new Map<number[], number>();
  const available = (bucket?: number[]) => {
    if (!bucket) return undefined;
    let cursor = cursors.get(bucket) ?? 0;
    while (cursor < bucket.length && forward.has(bucket[cursor]!)) cursor++;
    cursors.set(bucket, cursor);
    return bucket[cursor];
  };
  const ordered = next.map((_, i) => i).slice(1)
    .sort((a, b) => next[b]!.weight - next[a]!.weight || a - b);
  for (const b of ordered) {
    if (backward.has(b)) continue;
    const parent = backward.get(next[b]!.parent);
    const a = available(parent === undefined ? undefined : local.get(`${parent}:${next[b]!.signature}`))
      ?? available(bySignature.get(next[b]!.signature));
    if (a === undefined) continue;
    const pending: [number, number][] = [[a, b]];
    const pairs: [number, number][] = [];
    let compatible = true;
    while (pending.length) {
      const [x, y] = pending.pop()!;
      if ((forward.has(x) && forward.get(x) !== y) || (backward.has(y) && backward.get(y) !== x)) {
        compatible = false;
        break;
      }
      pairs.push([x, y]);
      old[x]!.children.forEach((child, i) => pending.push([child, next[y]!.children[i]!]));
    }
    if (!compatible) continue;
    for (const [x, y] of pairs) pair(x, y);
    propagateUp(a, b);
  }

  // Bottom-up optimization: prefer the compatible parent supported by the
  // largest total weight of already matched children.
  for (let b = next.length - 1; b > 0; b--) {
    if (backward.has(b)) continue;
    const votes = new Map<number, number>();
    for (const child of next[b]!.children) {
      const mate = backward.get(child);
      if (mate === undefined) continue;
      const a = old[mate]!.parent;
      if (a > 0 && !forward.has(a) && old[a]!.node.tag === next[b]!.node.tag) {
        votes.set(a, (votes.get(a) ?? 0) + next[child]!.weight);
      }
    }
    let best = -1, weight = 0;
    for (const [a, vote] of votes) if (vote > weight) { best = a; weight = vote; }
    if (best >= 0) pair(best, b);
  }
  // Top-down lazy propagation: only unambiguous remaining labels are paired.
  // Preorder ensures newly paired children are visited later in the same pass.
  for (let b = 0; b < next.length; b++) {
    const a = backward.get(b);
    if (a === undefined) continue;
    const left = group(old[a]!.children.filter(i => !forward.has(i)), i => old[i]!.node.tag);
    const right = group(next[b]!.children.filter(i => !backward.has(i)), i => next[i]!.node.tag);
    for (const [tag, candidates] of left) {
      const targets = right.get(tag);
      if (candidates.length === 1 && targets?.length === 1) pair(candidates[0]!, targets[0]!);
    }
  }
  let unchangedNodes = 0;
  for (const [a, b] of forward) {
    if (a !== 0 && old[a]!.node.text === next[b]!.node.text) unchangedNodes++;
  }
  return { old, next, forward, backward, summary: {
    oldNodes: old.length - 1, newNodes: next.length - 1,
    matchedNodes: forward.size - 1, unchangedNodes,
  } };
}

// Indices of a longest increasing subsequence, O(n log n). Removing inserts and
// cross-parent moves before this step prevents index shifts becoming fake moves.
function orderedPositions(values: number[]): Set<number> {
  const tails: number[] = [], previous = new Array<number>(values.length).fill(-1);
  values.forEach((value, i) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[tails[mid]!]! < value) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) previous[i] = tails[lo - 1]!;
    tails[lo] = i;
  });
  const result = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]!) result.add(i);
  return result;
}

function address(nodes: IndexedNode[], id: number): Address {
  const entry = nodes[id]!;
  return { path: entry.node.path, parent: nodes[entry.parent]!.node.path, index: entry.position };
}
function value(node: TreeNode): Value {
  return { tag: node.tag, ...(node.text === undefined ? {} : { text: node.text }) };
}
function buildEdits(m: Matching, refineText: boolean): BuldEdit[] {
  const { old, next, forward, backward } = m;
  const edits: BuldEdit[] = [];
  for (let a = 1; a < old.length; a++) {
    if (!forward.has(a)) edits.push({ type: 'delete', from: address(old, a), value: value(old[a]!.node) });
  }
  for (let b = 1; b < next.length; b++) {
    const a = backward.get(b);
    if (a === undefined) {
      edits.push({ type: 'insert', to: address(next, b), value: value(next[b]!.node) });
      continue;
    }
    const before = old[a]!.node.text, after = next[b]!.node.text;
    if (before !== after) {
      edits.push({ type: 'update', from: address(old, a), to: address(next, b),
        before: before ?? '', after: after ?? '',
        ...(refineText ? { words: diffWords(before ?? '', after ?? '').map(change => ({
          op: change.added ? 'insert' as const : change.removed ? 'delete' as const : 'equal' as const,
          text: change.value,
        })) } : {}),
      });
    }
    if (forward.get(old[a]!.parent) !== next[b]!.parent) {
      edits.push({ type: 'move', from: address(old, a), to: address(next, b) });
    }
  }
  for (const [a, b] of forward) {
    const children = next[b]!.children.filter(child => {
      const mate = backward.get(child);
      return mate !== undefined && old[mate]!.parent === a;
    });
    const kept = orderedPositions(children.map(child => old[backward.get(child)!]!.position));
    children.forEach((child, i) => {
      if (!kept.has(i)) edits.push({ type: 'move', from: address(old, backward.get(child)!), to: address(next, child) });
    });
  }
  return edits;
}

export class BuldDiffer extends Differ<TreeRep, BuldDiff> {
  readonly name: string;
  constructor(private options: { refineText?: boolean } = {}) {
    super();
    this.name = options.refineText ? 'buld-word-refined' : 'buld';
  }
  protected parse(html: string): TreeRep { return htmlToTree(html); }
  protected computeDiff(oldRep: TreeRep, newRep: TreeRep): DiffResult<BuldDiff> {
    const matching = matchTrees(oldRep, newRep);
    const diff = { edits: buildEdits(matching, this.options.refineText ?? false), summary: matching.summary };
    return { algorithm: this.name, diff,
      stats: { sizeBytes: new TextEncoder().encode(JSON.stringify(diff)).length } };
  }
  protected computeSimilarity(oldRep: TreeRep, newRep: TreeRep, diff?: DiffResult<BuldDiff>): number {
    const summary = diff?.diff.summary ?? matchTrees(oldRep, newRep).summary;
    const total = summary.oldNodes + summary.newNodes;
    return total === 0 ? 1 : 2 * summary.unchangedNodes / total;
  }
  override preview(result: DiffResult<BuldDiff>): PreviewRun[] {
    const runs: PreviewRun[] = [];
    for (const edit of result.diff.edits) {
      if (runs.length >= MAX_RUNS) break;
      if (edit.type === 'update') {
        if (edit.words) runs.push(...edit.words.slice(0, MAX_RUNS - runs.length));
        else runs.push({ op: 'delete', text: edit.before }, { op: 'insert', text: edit.after });
      } else if (edit.type === 'move') {
        // Moves are explicit so a reorder is not displayed as unchanged.
        runs.push({ op: 'move', text: `Moved ${edit.from.path} → ${edit.to.path}` });
      } else {
        runs.push({ op: edit.type, text: `${edit.value.tag}: ${edit.value.text ?? ''} (${edit.type === 'insert' ? edit.to.path : edit.from.path})` });
      }
    }
    return runs.slice(0, MAX_RUNS).map(shortenRun);
  }
}
