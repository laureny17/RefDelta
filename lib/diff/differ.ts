import type {
Representation,
DiffResult
} from "./diff-interfaces";

import type {  Classification,
    Classifier} from "../classify/classify-interface";

export interface CompareResult {
    diff: DiffResult;
    classification: Classification;
}

export abstract class Differ<R extends Representation> {
    abstract readonly name: string;

    constructor(protected classifier?: Classifier) {}

    protected abstract parse(html: string): R;

    protected abstract computeSimilarity(oldRep: R, newRep: R): number;

    protected abstract computeDiff(oldRep: R, newRep: R): DiffResult;

    compare(oldHtml: string, newHtml: string): CompareResult {

        const start = performance.now();

        const oldRep = this.parse(oldHtml);
        const newRep = this.parse(newHtml);

        const diff = this.computeDiff(oldRep, newRep);

        diff.stats.timeMs = performance.now() - start;

        const classification = this.classifier
        ? this.classifier.classify(diff)
        : { label: "unchanged" as const, kinds: [] };

        return { diff, classification };
    }
}
