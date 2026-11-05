import type { DifferMetrics } from './metrics';
import type { PageContent } from './parse/extract';
import type { Snapshot } from './wayback';

// analysis state for one tab, written by the background script and rendered by the popup.
// fields fill in as each stage finishes
export interface Analysis {
  error?: string; // analysis failed
  livePage?: PageContent; // what the content script sends back (see lib/parse/extract.ts)
  snapshot?: Snapshot | null; // undefined = lookup in progress, null = no snapshot found
  snapshotError?: string;
  differMetrics?: DifferMetrics[]; // each differ run on (snapshot, live page); undefined = not done yet
  metricsError?: string; // e.g. snapshot HTML couldn't be fetched
  linksToLookUp?: string[]; // the L1 links we'll look up snapshots for (capped; see MAX_LINKS)
  linkLookups?: Record<string, LinkLookup>; // keyed by link URL; missing = not looked up yet
  linkLookupsStopped?: string; // why link lookups stopped early (e.g. Wayback rate limit)
  totalDurationMs?: number; // total time spent on all link lookups
}

// result of looking up one L1 link's latest snapshot
export type LinkLookup =
  | { snapshot: Snapshot | null; durationMs: number }
  | { error: string; durationMs: number };

// TEMPORARY: per-tab results are stored in storage.session (cleared when the browser closes)
// TODO: replace/complement with IndexedDB
export function analysisKey(tabId: number): string {
  return `analysis:${tabId}`;
}
