# Diff algorithms

Each diff algorithm ("differ") compares a page's Wayback snapshot to its live version. Every differ is one class in its own file, extending `Differ` (`differ.ts`). The extension runs every differ on the same pages and shows their results side by side in the popup, so we can compare algorithms.

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

`compare()` also returns a classification (unchanged / minor / major) from the similarity, if the differ has a `Classifier` (`lib/classify/classify-interface.ts`); none exists yet as of 11/04

`Differ.similarity(oldHtml, newHtml)` gets **just the similarity**, without a diff: it runs only `parse` + `computeSimilarity` (with no `diff` passed in). It's for the L1 links: we could compare every link's full diff up front vs. only a similarity during the crawl, with the full diff computed when the user opens the link. No need to write anything extra for it, as long as your `computeSimilarity` works without a diff. Nothing calls it yet (as of 11/04).

## Representations

`parse()` returns one of the representations in `diff-interfaces.ts`:

- **`TextRep`**: a flat list of tokens (words, blocks, ...). For text-based algorithms (Myers, shingling, content-defined chunking)
- **`TreeRep`**: the page as a tree of elements. For structure-based algorithms (X-Diff, BULD). **Nothing builds this yet**: someone needs to write the page → tree parser first, then the tree algorithms can share it

For text, start from the shared parser like `MyersDiffer.parse()` does:

```ts
const doc = parseHtml(html);                       // works in the background script + Node (lib/parse/html.ts)
const { blocks } = extract(doc, 'about:blank');    // main content, boilerplate removed (lib/parse/extract.ts)
```

Use the shared parser so that differences between algorithms come from the algorithms, not from parsing.

## Adding an algorithm

1. Create `lib/diff/<name>.ts`:

   ```ts
   import { extract } from '../parse/extract';
   import { parseHtml } from '../parse/html';
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
       const { blocks } = extract(parseHtml(html), 'about:blank');
       return { kind: 'text', tokens: blocks.flatMap((b) => b.split(' ')) };
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
2. Add one line to `DIFFERS` in `lib/metrics.ts`:

   ```ts
   const DIFFERS: Differ<Representation>[] = [
     new MyersDiffer('word'),
     new MyersDiffer('block'),
     new MyDiffer(),   // ← here
   ];
   ```

## Checking the results

**In the extension:** run `npm run dev`, open a page, click "Analyze this page". The "Differ metrics" table shows a row per algorithm (parse / diff / similarity time, diff size, similarity), and below it a collapsible preview of each algorithm's diff. If your differ throws, its row should show the error instead.

## Avoiding conflicts

So we can build concurrently:

- **Put everything for your algorithm in your own file** (`lib/diff/<name>.ts`, plus helpers in their own files if needed)
- **The only shared edit is your one line in `DIFFERS`.** Add it at the end of the list; one-line conflicts there are easy to resolve
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

- **Classifier:** labels unchanged / minor / major from the similarity; thresholds to be set by experiments; not built yet
-
- **L1 links:** not diffed yet. When they are, we could try both strategies: `compare()` (full diff) for every link vs. `similarity()` during the crawl + `compare()` when the user opens a link
- **Measuring accuracy:** Might want to have some way of scoring/benchmarking(?) the algorithms somehow, if we're looking to have some sort of quantitative comparison.
