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
    timings: Timings;
}

// how long each step of compare() took, in ms
export interface Timings {
    parseMs: number; // time spent turning both pages' HTML into what the differ compares (e.g. Myers: a list of words)
    diffMs: number; // computeDiff
    similarityMs: number; // computeSimilarity
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

        const t0 = performance.now();
        const oldRep = this.parse(oldHtml);
        const newRep = this.parse(newHtml);
        const t1 = performance.now();
        const diff = this.computeDiff(oldRep, newRep);
        const t2 = performance.now();
        const similarity = this.computeSimilarity(oldRep, newRep, diff);
        const t3 = performance.now();

        const classification = this.classifier?.classify(diff);
        const timings = { parseMs: t1 - t0, diffMs: t2 - t1, similarityMs: t3 - t2 };

        return { diff, similarity, classification, timings };
    }
}
