import type {
Representation,
DiffResult
} from "./diff-interfaces";

import type {  Classification,
    Classifier} from "../classify/classify-interface";
import type { PreviewRun } from "./preview";

export interface CompareResult<D = unknown> {
    diff: DiffResult<D>;
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

// what similarity() returns: just the score, no diff
export interface SimilarityResult {
    similarity: number; // 1 = identical, 0 = nothing in common
    classification?: Classification; // undefined if this differ has no classifier
    timings: Omit<Timings, "diffMs">;
}

// R: what the algorithm compares (see diff-interfaces.ts); D: the shape of its diff
export abstract class Differ<R extends Representation, D = unknown> {
    abstract readonly name: string;

    constructor(protected classifier?: Classifier) {}

    protected abstract parse(html: string): R;

    // `diff` is passed when compare() already computed one, so algorithms whose similarity comes from the diff
    // (e.g. Myers) can reuse it; algorithms with a cheaper way (e.g. shingling) can ignore it.
    // must also work WITHOUT `diff`: similarity() calls it on its own
    protected abstract computeSimilarity(oldRep: R, newRep: R, diff?: DiffResult<D>): number;

    protected abstract computeDiff(oldRep: R, newRep: R): DiffResult<D>;

    // optional: a short, readable version of this algorithm's diff, for the popup (see preview.ts).
    // not called by compare(); override it to show your algorithm's changes. default: nothing to show
    preview(_diff: DiffResult<D>): PreviewRun[] {
        return [];
    }

    compare(oldHtml: string, newHtml: string): CompareResult<D> {

        const t0 = performance.now();
        const oldRep = this.parse(oldHtml);
        const newRep = this.parse(newHtml);
        const t1 = performance.now();
        const diff = this.computeDiff(oldRep, newRep);
        const t2 = performance.now();
        const similarity = this.computeSimilarity(oldRep, newRep, diff);
        const t3 = performance.now();

        const classification = this.classifier?.classify(similarity);
        const timings = { parseMs: t1 - t0, diffMs: t2 - t1, similarityMs: t3 - t2 };

        return { diff, similarity, classification, timings };
    }

    // just the similarity, without computing a diff (cheaper for some algorithms, e.g. shingling).
    // for L1 links: could compute every link's full diff up front vs. only a similarity during the crawl + the full diff
    // when the user opens the link
    similarity(oldHtml: string, newHtml: string): SimilarityResult {

        const t0 = performance.now();
        const oldRep = this.parse(oldHtml);
        const newRep = this.parse(newHtml);
        const t1 = performance.now();
        const similarity = this.computeSimilarity(oldRep, newRep);
        const t2 = performance.now();

        const classification = this.classifier?.classify(similarity);

        return { similarity, classification, timings: { parseMs: t1 - t0, similarityMs: t2 - t1 } };
    }
}
