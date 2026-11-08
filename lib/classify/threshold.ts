// the general classifier: labels a page from its similarity score, using two cutoffs.
// the same score can mean different things for different algorithms (e.g. myers-word vs myers-block on the same page),
// so an algorithm can pass its own thresholds; see the Differ constructor (lib/diff/differ.ts)

import type { Classification, Classifier } from './classify-interface';

export interface Thresholds {
  unchanged: number; // similarity at or above this = "unchanged"
  minor: number; // similarity at or above this (but below `unchanged`) = "minor"; below this = "major"
}

// TODO: PLACEHOLDER values, not based on any data yet; to be set by experiments
const DEFAULT_THRESHOLDS: Thresholds = { unchanged: 0.99, minor: 0.8 };

export class ThresholdClassifier implements Classifier {
  readonly name = 'threshold';

  constructor(private thresholds: Thresholds = DEFAULT_THRESHOLDS) {}

  classify(similarity: number): Classification {
    if (similarity >= this.thresholds.unchanged) return { label: 'unchanged' };
    return { label: similarity >= this.thresholds.minor ? 'minor' : 'major' };
  }
}
