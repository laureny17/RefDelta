import { type DiffResult } from "../diff/diff-interfaces";

export type ChangeLabel = "unchanged" | "minor" | "major";

export interface Classification {
    label: ChangeLabel;
    similarity?: number;
}

export interface Classifier {
    name: string;
    classify(diff: DiffResult): Classification;
}
