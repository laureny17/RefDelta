// labels how much a page changed, from its similarity score.
// only for pages where both versions exist: link rot and "no snapshot" are decided earlier, before any diff runs
// (link status checker + snapshot lookup)

export type ChangeLabel = "unchanged" | "minor" | "major";

export interface Classification {
    label: ChangeLabel;
}

export interface Classifier {
    name: string;
    // `similarity`: 0-1, from the differ's computeSimilarity
    // TODO: thresholds may need to be per algorithm, maybe??
    classify(similarity: number): Classification;
}
