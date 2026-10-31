import type { Snapshot } from './wayback';

// what the content script sends back (see collectLinks in content.ts)
// TODO: change this interface as content script evolves!
export interface PageLinks {
  url: string;
  title: string;
  links: string[];
  malformed: string[];
}

// analysis state for one tab, written by the background script and rendered by the popup.
// fields fill in as each stage finishes
export interface Analysis {
  error?: string; // analysis failed
  livePage?: PageLinks;
  snapshot?: Snapshot | null; // undefined = lookup in progress, null = no snapshot found
  snapshotError?: string;
}

// TEMPORARY: per-tab results are stored in storage.session (cleared when the browser closes)
// TODO: replace/complement with IndexedDB
export function analysisKey(tabId: number): string {
  return `analysis:${tabId}`;
}
