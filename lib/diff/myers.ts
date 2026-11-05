// baseline differ: Myers' O(ND) diff ("An O(ND) Difference Algorithm and Its Variations", Myers 1986) over the
// page's text, via the jsdiff library (`diff` on npm). its README says its deviations from the paper
// "don't affect results but do affect performance"
//
// compares a flat sequence of tokens: either words, or blocks (paragraphs/headings/list items; see lib/parse/)

import { diffArrays } from 'diff';
import { extract } from '../parse/extract';
import { parseHtml } from '../parse/html';
import type { DiffResult, TextRep } from './diff-interfaces';
import { Differ } from './differ';
import { MAX_RUNS, shortenRun, type PreviewRun } from './preview';

export type Granularity = 'word' | 'block';

// what Myers produces: the old text turned into the new one as a sequence of runs
export interface MyersDiff {
  granularity: Granularity;
  changes: { op: 'equal' | 'insert' | 'delete'; tokens: string[] }[]; // in order
  counts: { equal: number; insert: number; delete: number }; // counts per op
}

export class MyersDiffer extends Differ<TextRep> {
  readonly name: string;

  constructor(private granularity: Granularity = 'word') {
    super();
    this.name = `myers-${granularity}`;
  }

  // works anywhere, incl. the background script and Node (see lib/parse/html.ts)
  protected parse(html: string): TextRep {
    const doc = parseHtml(html);
    // the URL only matters for resolving links, which the text diff doesn't use
    const { blocks } = extract(doc, 'about:blank');
    const tokens = this.granularity === 'block' ? blocks : blocks.flatMap((b) => b.split(' '));
    return { kind: 'text', tokens };
  }

  // fraction of tokens the two versions share: 2 * equal / (old + new)
  // needs the diff's count of equal tokens: reuses `diff` if given, otherwise runs the diff
  protected computeSimilarity(oldRep: TextRep, newRep: TextRep, diff?: DiffResult): number {
    const total = oldRep.tokens.length + newRep.tokens.length;
    const { counts } = diff ? (diff.diff as MyersDiff) : this.myers(oldRep, newRep);
    return total === 0 ? 1 : (2 * counts.equal) / total;
  }

  protected computeDiff(oldRep: TextRep, newRep: TextRep): DiffResult {
    const diff = this.myers(oldRep, newRep);
    return {
      algorithm: this.name,
      diff,
      stats: { sizeBytes: new TextEncoder().encode(JSON.stringify(diff)).length },
    };
  }

  // the diff's runs, in order, with long ones shortened
  override preview(diff: DiffResult): PreviewRun[] {
    const { changes, granularity } = diff.diff as MyersDiff;
    const sep = granularity === 'block' ? '\n' : ' ';
    return changes.slice(0, MAX_RUNS).map(({ op, tokens }) => shortenRun({ op, text: tokens.join(sep) }));
  }

  private myers(oldRep: TextRep, newRep: TextRep): MyersDiff {
    const counts = { equal: 0, insert: 0, delete: 0 };
    const changes = diffArrays(oldRep.tokens, newRep.tokens).map((c) => {
      const op = c.added ? 'insert' : c.removed ? 'delete' : 'equal';
      counts[op] += c.value.length;
      return { op, tokens: c.value } as const;
    });
    return { granularity: this.granularity, changes, counts };
  }
}
