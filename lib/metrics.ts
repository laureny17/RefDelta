// runs every differ on (snapshot, live page) and summarizes the results for the popup
// TEMPORARY: results are only shown in the popup for now, not stored

import type { Differ, Timings } from './diff/differ';
import type { Representation } from './diff/diff-interfaces';
import { MyersDiffer } from './diff/myers';
import type { PreviewRun } from './diff/preview';

// the differs to measure; to add an algorithm, add one line here (see lib/diff/README.md)
const DIFFERS: Differ<Representation>[] = [
  new MyersDiffer('word'),
  new MyersDiffer('block'),
];

export type DifferMetrics =
  | {
      algorithm: string;
      timings: Timings; // parse / diff / similarity, in ms
      sizeBytes: number; // size of the diff as JSON
      similarity: number; // 0-1, from the differ's computeSimilarity
      label?: string; // classifier output; undefined = no classifier yet
      preview?: PreviewRun[]; // what changed, shortened for display; left out with { preview: false }
    }
  | { algorithm: string; error: string };

// `preview: false` leaves out the diff previews (e.g. for L1 links, to keep the saved results small)
export function measureDiffers(snapshotHtml: string, liveHtml: string, { preview = true } = {}): DifferMetrics[] {
  return DIFFERS.map((differ) => {
    try {
      const { diff, similarity, classification, timings } = differ.compare(snapshotHtml, liveHtml);
      return {
        algorithm: diff.algorithm,
        timings,
        sizeBytes: diff.stats.sizeBytes,
        similarity,
        label: classification?.label,
        ...(preview && { preview: differ.preview(diff) }),
      };
    } catch (err) {
      return { algorithm: differ.name, error: `${err}` };
    }
  });
}
