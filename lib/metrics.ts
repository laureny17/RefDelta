// runs the differs on (snapshot, live page) and summarizes the results for the popup
// TEMPORARY: results are only shown in the popup for now, not stored

import type { Differ, Timings } from './diff/differ';
import type { Representation } from './diff/diff-interfaces';
import { MyersDiffer } from './diff/myers';
import type { PreviewRun } from './diff/preview';

// one way of analyzing a page: which differ runs on the main page, and which on each L1 link
export interface DiffStrategy {
  main: Differ<Representation>; // full diff + similarity (Differ.compare()), shown in the popup
  // similarity only (Differ.similarity()): whether that needs a full diff depends on the algorithm (e.g. Myers does,
  // shingling doesn't). to see a link's full diff, open the link and click Analyze (it becomes the main page)
  l1: Differ<Representation>;
}

// the strategies to measure; to add an algorithm, add one line here (see lib/diff/README.md)
const STRATEGIES: DiffStrategy[] = [
  { main: new MyersDiffer('word'), l1: new MyersDiffer('word') },
  { main: new MyersDiffer('block'), l1: new MyersDiffer('block') },
];

// each differ runs once per page, even if several strategies use it (e.g. Myers on the main page with two
// different L1 differs), so its time is counted once. differs are told apart by name, so names must be unique
const MAIN_DIFFERS = uniqueByName(STRATEGIES.map((s) => s.main));
const L1_DIFFERS = uniqueByName(STRATEGIES.map((s) => s.l1));

function uniqueByName(differs: Differ<Representation>[]): Differ<Representation>[] {
  return [...new Map(differs.map((d) => [d.name, d])).values()];
}

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

// like DifferMetrics, but from Differ.similarity(): no diff, so no diff time / size / preview
export type SimilarityMetrics =
  | { algorithm: string; timings: Omit<Timings, 'diffMs'>; similarity: number; label?: string }
  | { algorithm: string; error: string };

// for the main page: each strategy's main differ (full diff + similarity)
export function measureDiffers(snapshotHtml: string, liveHtml: string): DifferMetrics[] {
  return MAIN_DIFFERS.map((differ) => {
    try {
      const { diff, similarity, classification, timings } = differ.compare(snapshotHtml, liveHtml);
      return {
        algorithm: diff.algorithm,
        timings,
        sizeBytes: diff.stats.sizeBytes,
        similarity,
        label: classification?.label,
        preview: differ.preview(diff),
      };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}

// for each L1 link: each strategy's L1 differ, similarity only (see lib/linkDiff.ts)
export function measureSimilarity(snapshotHtml: string, liveHtml: string): SimilarityMetrics[] {
  return L1_DIFFERS.map((differ) => {
    try {
      const { similarity, classification, timings } = differ.similarity(snapshotHtml, liveHtml);
      return { algorithm: differ.name, timings, similarity, label: classification?.label };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}
