# Diff algorithms

**L0** = the page being analyzed; **L1** = the links on it.

Each diff algorithm ("differ") compares a page's Wayback snapshot to its live version. Every differ is one class in its own file, extending `Differ` (`differ.ts`). Differs are grouped into **strategies** (`DiffStrategy` in `lib/metrics.ts`): one differ for L0 and one for each L1 link (usually the same one). The extension runs every strategy on the same pages and shows their results side by side in the popup, so we can compare algorithms.

`myers.ts` is the baseline, usable as a reference when adding a new one.

## How a differ is run

```
snapshot HTML ─┐                         ┌─ computeDiff ─────────► diff
               ├─ parse (both pages) ────┤
live HTML ─────┘                         └─ computeSimilarity ───► similarity (0-1)
```

`Differ.compare(oldHtml, newHtml)` (in `differ.ts`) runs these steps in order and times each one. Each algorithm only implements the methods for each step (in its own file), and `compare()` calls them; `compare()` should not be overriden.

| method                                 | you write | what it does                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                               | required  | shown in the popup, e.g. `"myers-word"`; must be unique                                                                                                                                                                                                                  |
| `parse(html)`                        | required  | HTML string → the representation your algorithm compares (see below)                                                                                                                                                                                                      |
| `computeDiff(old, new)`              | required  | the diff itself, as a `DiffResult`                                                                                                                                                                                                                                       |
| `computeSimilarity(old, new, diff?)` | required  | how similar the two versions are: 1 = identical, 0 = nothing in common. It also receives the diff `compare()` just computed: use it if your similarity comes from the diff (Myers does), or ignore it if your algorithm computes similarity another way (e.g. shingling). `diff` may be undefined (see `similarity()` below), so this must also work without it |
| `preview(diff)`                      | optional  | a short, readable version of your diff for the popup (see `preview.ts`). Without it, the popup just shows no preview                                                                                                                                                     |

`compare()` and `similarity()` also return a classification (unchanged / minor / major) from the similarity. Every differ gets the general `ThresholdClassifier` (`lib/classify/threshold.ts`) by default, so there's nothing to write for it. The same score can mean different things for different algorithms, so once there's data, an algorithm can pass its own thresholds to the `Differ` constructor

`Differ.similarity(oldHtml, newHtml)` gets **just the similarity**, without a diff: it runs only `parse` + `computeSimilarity` (with no `diff` passed in). It's used for **every L1 link**: each link only needs a similarity score (to see a link's full diff, the user opens the link and clicks Analyze). Whether that's cheaper than a full diff depends on your algorithm: Myers needs the diff to get its similarity, so its `computeSimilarity` runs the diff itself; shingling doesn't. No need to write anything extra for it, as long as your `computeSimilarity` works without a diff.

## Representations

`parse()` returns one of the representations in `diff-interfaces.ts`:

- **`TextRep`**: a flat list of tokens (words, blocks, ...). For text-based algorithms (Myers, shingling, content-defined chunking)
- **`TreeRep`**: the page as a tree of elements. For structure-based algorithms (X-Diff, BULD). **Nothing builds this yet**: someone needs to write the page → tree parser first, then the tree algorithms can share it

For text, start from the shared parser like `MyersDiffer.parse()` does:

```ts
const blocks = htmlToBlocks(html);   // main content's text, boilerplate removed; works in the background script + Node (lib/parse/html.ts)
```

Use the shared parser so that differences between algorithms come from the algorithms, not from parsing.

## Adding an algorithm

1. Create `lib/diff/<name>.ts`:

   ```ts
   import { htmlToBlocks } from '../parse/html';
   import type { DiffResult, TextRep } from './diff-interfaces';
   import { Differ } from './differ';
   import { MAX_RUNS, shortenRun, type PreviewRun } from './preview';

   // what your algorithm's diff looks like (any shape you want)
   export interface MyDiff {
     // ...
   }

   // Differ<what you compare, what your diff looks like>
   export class MyDiffer extends Differ<TextRep, MyDiff> {
     readonly name = 'my-algorithm';

     protected parse(html: string): TextRep {
       return { kind: 'text', tokens: htmlToBlocks(html).flatMap((b) => b.split(' ')) };
     }

     protected computeDiff(oldRep: TextRep, newRep: TextRep): DiffResult<MyDiff> {
       const diff: MyDiff = { /* ... */ };
       return {
         algorithm: this.name,
         diff,
         stats: { sizeBytes: new TextEncoder().encode(JSON.stringify(diff)).length },
       };
     }

     protected computeSimilarity(oldRep: TextRep, newRep: TextRep, diff?: DiffResult<MyDiff>): number {
       return /* 0-1 */;
     }

     // optional
     override preview(diff: DiffResult<MyDiff>): PreviewRun[] {
       const d = diff.diff; // already typed as MyDiff
       return [/* { op: 'insert' | 'delete' | 'equal', text } */].slice(0, MAX_RUNS).map(shortenRun);
     }
   }
   ```
2. Add one line to `STRATEGIES` in `lib/metrics.ts`:

   ```ts
   const STRATEGIES: DiffStrategy[] = [
     { L0: new MyersDiffer('word'), L1: new MyersDiffer('word') },
     { L0: new MyersDiffer('block'), L1: new MyersDiffer('block') },
     { L0: new MyDiffer(), L1: new MyDiffer() },   // ← here
   ];
   ```

   `L0` and `L1` don't have to be the same differ, e.g. `{ L0: new MyersDiffer('word'), L1: new MyDiffer() }` for Myers on L0 and a cheaper differ for L1 links. Each differ still runs only once per page, even if several strategies use it (differs are told apart by `name`)

## Checking the results

**In the extension:** run `npm run dev`, open a page, click "Analyze this page". The "Differ metrics" table shows a row per L0 differ (parse / diff / similarity time, diff size, similarity), and below it a collapsible preview of each one's diff. Each diffed L1 link shows every L1 differ's similarity. If your differ throws, its row (or its entry on a link) should show the error instead.

## Avoiding conflicts

So we can build concurrently:

- **Put everything for your algorithm in your own file** (`lib/diff/<name>.ts`, plus helpers in their own files if needed)
- **The only shared edit is your one line in `STRATEGIES`.** Add it at the end of the list; one-line conflicts there are easy to resolve
- **Don't change `differ.ts`, `diff-interfaces.ts`, `preview.ts`, `metrics.ts`, or `lib/parse/`** in an algorithm PR. If you need a change there (e.g. a new field everyone should report, or a parser option), make it a separate small PR, since every differ depends on them
- Branch off the latest `main` and keep your PR to one algorithm

## Algorithms from the proposal (§4.1)

| algorithm                          | representation       | status                                                                                                     |
| ---------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------- |
| Myers (word / block)               | `TextRep`          | complete in `myers.ts`                                                                                   |
| Shingling + Jaccard similarity     | `TextRep`          | ready to start                                                                                             |
| Content-defined chunking (FastCDC) | `TextRep`          | ready to start                                                                                             |
| X-Diff (tree edit distance)        | `TreeRep`          | needs the page → tree parser first                                                                        |
| BULD                               | `TreeRep`          | needs the page → tree parser first                                                                        |
| Vi-DIFF                            | tree + visual layout | needs visual page layout to be collected, which the background script doesn't currently have (as of 11/04) |

## TODOs

- **Classifier thresholds:** the current values in `lib/classify/threshold.ts` are placeholders, not based on any data; to be set by experiments, possibly per algorithm
- **Strategy costs:** a popup table with each strategy's total compute time (L0 + all its L1 links), to compare strategies as a whole
- **Measuring accuracy:** Might want to have some way of scoring/benchmarking(?) the algorithms somehow, if we're looking to have some sort of quantitative comparison.
