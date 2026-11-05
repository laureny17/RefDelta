// a short, human-readable version of a diff, for showing in the popup (see Differ.preview)
// shared by all algorithms so the popup can show any of them the same way

// one stretch of text that's all unchanged, all inserted, or all deleted
export interface PreviewRun {
  op: 'equal' | 'insert' | 'delete';
  text: string;
}

// limits so the preview stays small enough to store and show in the popup
export const MAX_RUNS = 100; // max runs to show
const MAX_CHARS = 300; // max length of a run's text before it's shortened
const CONTEXT_CHARS = 60; // a shortened unchanged run keeps this many chars from its start and end

// shortens a run's text if it's too long: unchanged text keeps its start + end (just context around the
// changes), inserted/deleted text keeps its start
export function shortenRun({ op, text }: PreviewRun): PreviewRun {
  if (text.length <= MAX_CHARS) return { op, text };
  return {
    op,
    text: op === 'equal'
      ? `${text.slice(0, CONTEXT_CHARS)} … ${text.slice(-CONTEXT_CHARS)}`
      : `${text.slice(0, MAX_CHARS)} …`,
  };
}
