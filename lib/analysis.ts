import type { LinkDiff, LinkDiffPhase } from './linkDiff';
import type { DifferMetrics } from './metrics';
import type { PageContent } from './parse/extract';
import type { Snapshot } from './wayback';

// configuration for analysis behavior
export interface AnalysisConfig {
  skipL1Similarity?: boolean; // If true, only parse L1 links without computing similarity (for benchmarking parse overhead)
  useFullL1Diffs?: boolean; // If true, compute full diffs for L1 links (for benchmarking diff overhead)
  // BENCHMARK ONLY: run every strategy whose L0 differ is in this list, overriding l0Algorithm/l1Algorithm
  // (e.g. ['myers-word', 'myers-block'] to compare both in one run)
  algorithms?: string[];
  l0Algorithm: string; // the differ to run on L0 (picked in the popup)
  l1Algorithm: string; // the differ to run on each L1 link (picked in the popup)
}

// analysis state for one tab, written by the background script and rendered by the popup.
// fields fill in as each stage finishes
export interface Analysis {
  error?: string; // analysis failed
  runState?: RunState;
  requestedDate?: string; // YYYY-MM-DD selected by the user; undefined = latest L0 snapshot
  l0Algorithm?: string; // differ picked in the popup for L0
  l1Algorithm?: string; // differ picked in the popup for L1 links
  livePage?: PageContent; // what the content script sends back (see lib/parse/extract.ts)
  snapshot?: Snapshot | null; // undefined = lookup in progress, null = no snapshot found
  snapshotError?: string;
  differMetrics?: DifferMetrics[]; // each differ run on (snapshot, live page); undefined = not done yet
  metricsError?: string; // e.g. snapshot HTML couldn't be fetched
  linksToLookUp?: string[]; // the L1 links we'll look up snapshots for (every link on the page); set when the L1 stage starts
  linkPhases?: Record<string, LinkPhase>; // keyed by link URL: the step each link is on; missing = not started (waiting for a rate-limit slot)
  linkLookups?: Record<string, LinkLookup>; // keyed by link URL; missing = not looked up yet
  linkLookupsStopped?: string; // why link lookups stopped early (e.g. Wayback rate limit)
  linkDiffs?: Record<string, LinkDiff>; // keyed by link URL, for links with a snapshot; missing = not diffed (yet)
  totalDurationMs?: number; // sum of each link lookup's own time (lookups overlap, so this isn't time waited)
  times?: Times;
}

// whether the run is still going (set from the popup's pause / resume / stop buttons)
//   running: in progress
//   paused: no new L1 lookups start until resumed (ones already sent still finish)
//   stopped: stopped by the user; no new lookups start, results so far are kept
//   done: finished on its own (incl. failing, or Wayback rate-limiting us; see error / linkLookupsStopped)
export type RunState = 'running' | 'paused' | 'stopped' | 'done';

// wall-clock time (ms) of each step, i.e. how long we actually wait; missing = not started/done yet
export interface Times {
  total?: number; // since analysis started; updates as it runs
  page?: number; // content script parsing the live page
  snapshotLookup?: number; // CDX lookup for this page
  snapshotDownload?: number; // fetching the snapshot's HTML (incl. waiting for a rate-limit slot)
  differs?: number; // running every differ (see differMetrics for each one's breakdown)
  linkLookups?: number; // first L1 lookup started -> latest lookup/diff finished (incl. waiting for slots); updates as it runs
}

// the step one L1 link is on. stays at the last step started, so a result in linkLookups/linkDiffs
// (or linkLookupsStopped) takes precedence over it
export type LinkPhase =
  | 'lookingUp' // CDX request for a snapshot near the L0 snapshot sent (or about to be, within its slot)
  | LinkDiffPhase; // checking the live page / downloading the snapshot (see lib/linkDiff.ts)

// result of looking up one L1 link's snapshot closest to the L0 snapshot
export type LinkLookup =
  | { snapshot: Snapshot | null; durationMs: number }
  | { error: string; durationMs: number };

// TEMPORARY: per-tab results are stored in storage.session (cleared when the browser closes)
// TODO: replace/complement with IndexedDB
export function analysisKey(tabId: number): string {
  return `analysis:${tabId}`;
}

// Config key for storing analysis configuration
export const CONFIG_KEY = 'analysisConfig';
