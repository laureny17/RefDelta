import type {
Representation,
DiffResult
} from "./diff-interfaces";

import type {  Classification,
    Classifier} from "../classify/classify-interface";

export interface CompareResult {
    diff: DiffResult;
    similarity: number; // from computeSimilarity: 1 = identical, 0 = nothing in common
    classification?: Classification; // undefined if this differ has no classifier
}

export abstract class Differ<R extends Representation> {
    abstract readonly name: string;

    constructor(protected classifier?: Classifier) {}

    protected abstract parse(html: string): R;

    // `diff` is passed when compare() already computed one, so algorithms whose similarity comes from the diff
    // (e.g. Myers) can reuse it; algorithms with a cheaper way (e.g. shingling) can ignore it.
    // kept separate from computeDiff so we can later get just the similarity without a full diff
    protected abstract computeSimilarity(oldRep: R, newRep: R, diff?: DiffResult): number;

    protected abstract computeDiff(oldRep: R, newRep: R): DiffResult;

    compare(oldHtml: string, newHtml: string): CompareResult {

        const start = performance.now();

        const oldRep = this.parse(oldHtml);
        const newRep = this.parse(newHtml);

        const diff = this.computeDiff(oldRep, newRep);

        diff.stats.timeMs = performance.now() - start;

        // not included in timeMs
        const similarity = this.computeSimilarity(oldRep, newRep, diff);

        const classification = this.classifier?.classify(diff);

        return { diff, similarity, classification };
    }
}
