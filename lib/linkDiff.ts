// diffs one L1 link: fetches its live page (from the link's own site) + its snapshot's HTML (from Wayback),
// then runs every differ on them, like we do for the main page.

// performs full diff for every link upfront.
// TODO: add the alternative option: only Differ.similarity() here, and compute the full diff when the user opens the link

// only the L1 page's own content is diffed; its links (L2) aren't followed; we stop
// after one level: when the user opens an L1 page, it becomes the new L0 and gets analyzed from there

import { measureDiffers, type DifferMetrics } from './metrics';
import { fetchSnapshotHtml, type Snapshot } from './wayback';
import { WaybackRateLimitedError } from './waybackQueue';

// give up on a live page after this long (same as Wayback requests)
const LIVE_TIMEOUT_MS = 30 * 1000;

export type LinkDiff =
  // both versions fetched + diffed
  | { live: LiveFetch; metrics: DifferMetrics[]; durationMs: number } // without previews (see diffLink)
  // live page fetched but not diffed (e.g. a 404, or not an HTML page)
  | { live: LiveFetch; skipped: string; durationMs: number }
  // something failed (e.g. network error, timeout, snapshot fetch failed)
  | { error: string; durationMs: number };

// what we got back when fetching the live page
export interface LiveFetch {
  status: number; // HTTP status, e.g. 200, 404
  // the URL we ended up at, if it redirected
  // TODO: link status checker: flag 404s + redirects to an unrelated page as link rot
  redirectedTo?: string;
}

// throws WaybackRateLimitedError if Wayback rate-limits the snapshot fetch, so the caller can stop
export async function diffLink(link: string, snapshot: Snapshot): Promise<LinkDiff> {
  const start = performance.now();
  const durationMs = () => performance.now() - start;

  let live: LiveFetch;
  let liveHtml: string;
  try {
    // NOT through the Wayback queue: this goes to the link's own site, so Wayback's rate limit doesn't apply
    // (needs host_permissions for all sites; see wxt.config.ts)
    // raw HTML, before any JavaScript runs, same as the snapshot (unlike the main page, which we read after JS)
    const res = await fetch(link, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    live = { status: res.status, ...(res.redirected && { redirectedTo: res.url }) };
    if (!res.ok) return { live, skipped: `live page returned ${res.status}`, durationMs: durationMs() };
    const type = res.headers.get('Content-Type') ?? '';
    if (!type.includes('html')) return { live, skipped: `not an HTML page (${type || 'unknown type'})`, durationMs: durationMs() };
    liveHtml = await res.text();
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    return { error: timedOut ? `live page timed out after ${LIVE_TIMEOUT_MS / 1000}s` : `live page: ${err}`, durationMs: durationMs() };
  }

  let snapshotHtml: string;
  try {
    snapshotHtml = await fetchSnapshotHtml(snapshot); // 1 more Wayback request, through the rate-limited queue
  } catch (err) {
    if (err instanceof WaybackRateLimitedError) throw err;
    return { error: `snapshot: ${err}`, durationMs: durationMs() };
  }

  // no previews: we diff up to MAX_LINKS links, and all results are re-saved on every update
  const metrics = measureDiffers(snapshotHtml, liveHtml, { preview: false });
  return { live, metrics, durationMs: durationMs() };
}
