// runs every differ on (snapshot, live page) and summarizes the results for the popup
// TEMPORARY: results are only shown in the popup for now, not stored

import type { Differ, Timings } from './diff/differ';
import type { DiffResult, Representation } from './diff/diff-interfaces';
import { MyersDiffer, type MyersDiff } from './diff/myers';

// the differs to measure; add new algorithms here
const DIFFERS: Differ<Representation>[] = [new MyersDiffer('word'), new MyersDiffer('block')];

export type DifferMetrics =
  | {
      algorithm: string;
      timings: Timings; // parse / diff / similarity, in ms
      sizeBytes: number; // size of the diff as JSON
      similarity: number; // 0-1, from the differ's computeSimilarity
      label?: string; // classifier output; undefined = no classifier yet
      preview: PreviewRun[]; // what changed, shortened for display
    }
  | { algorithm: string; error: string };

export interface PreviewRun {
  op: 'equal' | 'insert' | 'delete';
  text: string;
}

export function measureDiffers(snapshotHtml: string, liveHtml: string): DifferMetrics[] {
  return DIFFERS.map((differ) => {
    try {
      const { diff, similarity, classification, timings } = differ.compare(snapshotHtml, liveHtml);
      return {
        algorithm: diff.algorithm,
        timings,
        sizeBytes: diff.stats.sizeBytes,
        similarity,
        label: classification?.label,
        preview: previewOf(diff),
      };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}

// ---- per-algorithm helpers (each algorithm's diff has its own shape) ----

function isMyers(diff: DiffResult): boolean {
  return diff.algorithm.startsWith('myers-');
}

// limits so the preview stays small enough to store and show in the popup
const MAX_RUNS = 100; // max runs to show
const MAX_CHARS = 300; // max length of a run's text before it's shortened
const CONTEXT_CHARS = 60; // a shortened unchanged run keeps this many chars from its start and end

// the diff as a list of runs to show (a "run" is a stretch of text that's all unchanged, all inserted, or all deleted)
// TODO: preview for other algorithms' diff shapes
function previewOf(diff: DiffResult): PreviewRun[] {
  if (!isMyers(diff)) return [];
  const { changes, granularity } = diff.diff as MyersDiff;
  const sep = granularity === 'block' ? '\n' : ' ';
  return changes.slice(0, MAX_RUNS).map(({ op, tokens }) => {
    let text = tokens.join(sep);
    if (text.length > MAX_CHARS) {
      text = op === 'equal'
        ? `${text.slice(0, CONTEXT_CHARS)} … ${text.slice(-CONTEXT_CHARS)}`
        : `${text.slice(0, MAX_CHARS)} …`;
    }
    return { op, text };
  });
}
