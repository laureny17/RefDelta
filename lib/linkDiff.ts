// checks + diffs one L1 link: fetches its live page (from the link's own site) and checks it for link rot
// if it's fine and has a snapshot, fetches the snapshot's HTML (from Wayback) and
// runs every differ on them, like we do for the main page.

// two strategies, picked with L1_STRATEGY:
//   'full': full diff for every link up front (Differ.compare())
//   'similarity': only a similarity score per link (Differ.similarity()); to get the full diff, open the link and click Analyze

// only the L1 page's own content is diffed; its links (L2) aren't followed; we stop
// after one level: when the user opens an L1 page, it becomes the new L0 and gets analyzed from there

import { measureDiffers, measureSimilarity, type DifferMetrics, type SimilarityMetrics } from './metrics';
import { fetchSnapshotHtml, type Snapshot } from './wayback';
import { WaybackRateLimitedError } from './waybackQueue';

// the strategy to use for diffing L1 links
export const L1_STRATEGY: 'full' | 'similarity' = 'full';

// give up on a live page after this long (same as Wayback requests)
const LIVE_TIMEOUT_MS = 30 * 1000;

// HTTP statuses that don't tell us whether the page is gone, so they're not counted as link rot:
//   401: needs a login (we don't send the user's cookies),
//   429: rate limited,
//   403: often bot protection (e.g. Cloudflare), but some sites also use it for removed pages
// TODO: validate?
const BLOCKED_STATUSES = [401, 403, 429];

export type LinkDiff =
  // both versions fetched + diffed
  // (in 'similarity' mode, `metrics` has no diff info, just similarities)
  | { live: LiveFetch; metrics: (DifferMetrics | SimilarityMetrics)[]; durationMs: number } // without previews (see diffLink)
  // link rot: the live page is gone or the site can't be reached, so it isn't diffed
  | { live?: LiveFetch; rot: string; durationMs: number } // no `live` if the site couldn't be reached at all
  // live page is fine but not diffed (e.g. no snapshot, not an HTML page, blocked)
  | { live: LiveFetch; skipped: string; durationMs: number }
  // something failed (e.g. timeout, snapshot fetch failed)
  | { error: string; durationMs: number };

// what we got back when fetching the live page
export interface LiveFetch {
  status: number; // HTTP status, e.g. 200, 404
  // the URL we ended up at, if it redirected. redirects aren't counted as link rot (e.g. youtu.be -> youtube.com is fine)
  // TODO: detect unrelated redirects (e.g. to a domain parking page); maybe redirected + very low similarity to the snapshot?
  redirectedTo?: string;
}

// `snapshot`: the link's latest snapshot, or null if it has none (then it's only checked for link rot)
// throws WaybackRateLimitedError if Wayback rate-limits the snapshot fetch, so the caller can stop
export async function diffLink(link: string, snapshot: Snapshot | null): Promise<LinkDiff> {
  const start = performance.now();
  const durationMs = () => performance.now() - start;

  let live: LiveFetch;
  let liveHtml: string;
  try {
    // NOT through waybackFetch: this goes to the link's own site, so Wayback's rate limit doesn't apply
    // (needs host_permissions for all sites; see wxt.config.ts)
    // raw HTML, before any JavaScript runs, same as the snapshot (unlike the main page, which we read after JS)
    const res = await fetch(link, { signal: AbortSignal.timeout(LIVE_TIMEOUT_MS) });
    live = { status: res.status, ...(res.redirected && { redirectedTo: res.url }) };
    const rot = rotReason(res);
    if (rot) return { live, rot, durationMs: durationMs() };
    if (!res.ok) return { live, skipped: `live page returned ${res.status} (probably blocking automated requests)`, durationMs: durationMs() };
    if (!snapshot) return { live, skipped: 'no snapshot to compare against', durationMs: durationMs() };
    const type = res.headers.get('Content-Type') ?? '';
    if (!type.includes('html')) return { live, skipped: `not an HTML page (${type || 'unknown type'})`, durationMs: durationMs() };
    liveHtml = await res.text();
  } catch (err) {
    // a timeout could just be a slow site, so it's an error rather than link rot
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      return { error: `live page timed out after ${LIVE_TIMEOUT_MS / 1000}s`, durationMs: durationMs() };
    }
    // anything else (e.g. the domain no longer exists, connection refused): the site couldn't be reached at all
    // TODO: retry once before calling it rot?
    return { rot: `site unreachable (${err})`, durationMs: durationMs() };
  }

  let snapshotHtml: string;
  try {
    snapshotHtml = await fetchSnapshotHtml(snapshot); // 1 more Wayback request, rate-limited by waybackFetch
  } catch (err) {
    if (err instanceof WaybackRateLimitedError) throw err;
    return { error: `snapshot: ${err}`, durationMs: durationMs() };
  }

  // no previews: we diff up to MAX_LINKS links, and all results are re-saved on every update
  const metrics = L1_STRATEGY === 'full'
    ? measureDiffers(snapshotHtml, liveHtml, { preview: false }) // compute full diff
    : measureSimilarity(snapshotHtml, liveHtml); // only compute similarity score
  return { live, metrics, durationMs: durationMs() };
}

// why the live page counts as link rot, if it does:
//   an error status (e.g. 404 not found, 410 gone, 500), except ones that don't tell us if the page is gone (see BLOCKED_STATUSES)
// (an unreachable site is also rot; see diffLink)
function rotReason(res: Response): string | undefined {
  if (res.status >= 400 && !BLOCKED_STATUSES.includes(res.status)) return `live page returned ${res.status}`;
  return undefined;
}
