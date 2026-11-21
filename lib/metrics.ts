// runs the differs on (snapshot, live page) and summarizes the results for the popup
// TEMPORARY: results are only shown in the popup for now, not stored

import type { Differ, Timings } from './diff/differ';
import type { Representation } from './diff/diff-interfaces';
import { MyersDiffer } from './diff/myers';
import type { PreviewRun } from './diff/preview';
import type { AnalysisConfig } from './analysis';

// one way of analyzing a page: which differ runs on L0 (the page being analyzed), and which on each L1 link (the links on it)
export interface DiffStrategy {
  L0: Differ<Representation>; // full diff + similarity (Differ.compare()), shown in the popup
  // similarity only (Differ.similarity()): whether that needs a full diff depends on the algorithm (e.g. Myers does,
  // shingling doesn't). to see a link's full diff, open the link and click Analyze (it becomes the new L0)
  L1: Differ<Representation>;
}

// the strategies to measure; to add an algorithm, add one line here (see lib/diff/README.md)
const ALL_STRATEGIES: DiffStrategy[] = [
  { L0: new MyersDiffer('word'), L1: new MyersDiffer('word') },
  { L0: new MyersDiffer('block'), L1: new MyersDiffer('block') },
];

// every L0 / L1 differ. each differ runs once per page, even if several strategies use it (e.g. Myers on L0 with two
// different L1 differs), so its time is counted once. differs are told apart by name, so names must be unique
const L0_DIFFERS = uniqueByName(ALL_STRATEGIES.map((s) => s.L0));
const L1_DIFFERS = uniqueByName(ALL_STRATEGIES.map((s) => s.L1));

// names for the popup's algorithm selects
export const L0_ALGORITHMS = L0_DIFFERS.map((d) => d.name);
export const L1_ALGORITHMS = L1_DIFFERS.map((d) => d.name);

// what the popup selects start on: the simplest + cheapest differ
export const DEFAULT_L0_ALGORITHM = 'myers-block';
export const DEFAULT_L1_ALGORITHM = 'myers-block';

// the differs to run: just the one picked in the popup, unless a benchmark config asks for several (config.algorithms)
function getL0Differs(config: AnalysisConfig): Differ<Representation>[] {
  if (config.algorithms?.length) return uniqueByName(benchmarkStrategies(config.algorithms).map((s) => s.L0));
  return L0_DIFFERS.filter((d) => d.name === config.l0Algorithm);
}

function getL1Differs(config: AnalysisConfig): Differ<Representation>[] {
  if (config.algorithms?.length) return uniqueByName(benchmarkStrategies(config.algorithms).map((s) => s.L1));
  return L1_DIFFERS.filter((d) => d.name === config.l1Algorithm);
}

// BENCHMARK ONLY: every strategy whose L0 differ is in `algorithms`
function benchmarkStrategies(algorithms: string[]): DiffStrategy[] {
  return ALL_STRATEGIES.filter((s) => algorithms.includes(s.L0.name));
}

function uniqueByName(differs: Differ<Representation>[]): Differ<Representation>[] {
  return [...new Map(differs.map((d) => [d.name, d])).values()];
}

export type DifferMetrics =
  | {
      algorithm: string;
      timings: Timings; // parse / diff / similarity, in ms
      sizeBytes: number; // size of the diff as JSON
      similarity: number; // 0-1, from the differ's computeSimilarity
      label: string; // classifier output (unchanged / minor / major)
      preview: PreviewRun[]; // what changed, shortened for display
    }
  | { algorithm: string; error: string };

// like DifferMetrics, but from Differ.similarity(): no diff, so no diff time / size / preview
export type SimilarityMetrics =
  | { algorithm: string; timings: Omit<Timings, 'diffMs'>; similarity: number; label: string }
  | { algorithm: string; error: string };

// for L0: each strategy's L0 differ (full diff + similarity)
export function measureL0Diffs(snapshotHtml: string, liveHtml: string, config: AnalysisConfig): DifferMetrics[] {
  return getL0Differs(config).map((differ) => {
    try {
      const { diff, similarity, classification, timings } = differ.compare(snapshotHtml, liveHtml);
      return {
        algorithm: diff.algorithm,
        timings,
        sizeBytes: diff.stats.sizeBytes,
        similarity,
        label: classification.label,
        preview: differ.preview(diff),
      };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}

// for each L1 link: each strategy's L1 differ, similarity only (see lib/linkDiff.ts)
export function measureL1Similarities(snapshotHtml: string, liveHtml: string, config: AnalysisConfig): SimilarityMetrics[] {
  return getL1Differs(config).map((differ) => {
    try {
      const { similarity, classification, timings } = differ.similarity(snapshotHtml, liveHtml);
      return { algorithm: differ.name, timings, similarity, label: classification.label };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}

// for each L1 link: each strategy's L1 differ, FULL DIFF (same as L0 but for benchmarking)
export function measureL1Diffs(snapshotHtml: string, liveHtml: string, config: AnalysisConfig): DifferMetrics[] {
  return getL1Differs(config).map((differ) => {
    try {
      const { diff, similarity, classification, timings } = differ.compare(snapshotHtml, liveHtml);
      return {
        algorithm: diff.algorithm,
        timings,
        sizeBytes: diff.stats.sizeBytes,
        similarity,
        label: classification.label,
        preview: [], // Don't store preview for L1 to save memory
      };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}
