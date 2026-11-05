import { analysisKey, type Analysis, type LinkLookup, type Times } from '@/lib/analysis';
import { diffLink } from '@/lib/linkDiff';
import type { PageContent } from '@/lib/parse/extract';
import { measureDiffers } from '@/lib/metrics';
import { fetchSnapshotHtml, findLatestSnapshot, type Snapshot } from '@/lib/wayback';
import { WaybackRateLimitedError, pauseForRateLimit, throwIfPaused, waitForSlot } from '@/lib/waybackQueue';

// max number of L1 links to look up per page (pretty arbitrarily chosen for now)
// note that all Wayback requests are limited to 24/min (see waybackQueue.ts)
// TODO: which links should we analyze? should there be a "smart" way to determine which ones to look into, if we're being selective?
//       should we even cap? should we look into distributing work so we don't face rate-limiting issues?
const MAX_LINKS = 50;

// Set to true to use concurrent lookups (sent every 2.5s without waiting for responses)
// Set to false to use sequential lookups (one at a time)
const USE_CONCURRENT = true;

// mapping for the current analysis run for each tab (tabId -> runId)
const currentRun = new Map<number, number>();
let nextRunId = 0;

// runs the analysis in the background so it keeps going after the popup closes
export default defineBackground(() => {
  // listen for message from the popup to trigger analysis
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'analyze-tab') analyzeTab(msg.tabId);
  });

  // clear a tab's results when it loads a new page (or reloads), so the popup doesn't show prev page results
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') clearTab(tabId);
  });
  // clean up when a tab is closed
  browser.tabs.onRemoved.addListener((tabId) => clearTab(tabId));
});

// TEMPORARY: using storage.session for now;
// TODO: replace/complement with IndexedDB
function clearTab(tabId: number) {
  currentRun.delete(tabId);
  browser.storage.session.remove(analysisKey(tabId));
}

// analyze a single tab, saving results to storage.session as they become available
// TEMPORARY: using storage.session for now;
// TODO: replace/complement with IndexedDB
async function analyzeTab(tabId: number) {
  const key = analysisKey(tabId);
  const runId = ++nextRunId;
  currentRun.set(tabId, runId);
  // clear old results first
  await browser.storage.session.remove(key);
  const isCurrent = () => currentRun.get(tabId) === runId;

  // wall-clock time of each step (see Times); total and linkLookups are refreshed on every update
  const start = performance.now();
  let linksStart: number | undefined;
  const times: Times = {};

  // accumulated results; each update merges in new fields and re-saves the whole thing
  const analysis: Analysis = { times };
  const update = async (changes: Partial<Analysis>) => {
    Object.assign(analysis, changes);
    times.total = performance.now() - start;
    if (linksStart !== undefined) times.linkLookups = performance.now() - linksStart;
    // only save if this run is still current (else outdated: tab navigated/closed, or Analyze re-clicked)
    if (isCurrent()) await browser.storage.session.set({ [key]: analysis });
  };

  let livePage: PageContent;
  let liveHtml: string; // kept here only, not saved with the results (too big to re-save on every update)
  // try to get the page links from the content script
  try {
    ({ html: liveHtml, ...livePage } = await timed<PageContent & { html: string }>(times, 'page', () =>
      browser.tabs.sendMessage(tabId, { type: 'analyze' }),
    ));
  } catch (err) {
    await update({ error: `Could not analyze page: ${err}` });
    return;
  }
  await update({ livePage }); // links ready; snapshot still pending

  // try to find the latest Wayback snapshot for the page
  let snapshot: Snapshot | null = null;
  try {
    snapshot = await timed(times, 'snapshotLookup', () => findLatestSnapshot(livePage.url));
    await update({ snapshot });
  } catch (err) {
    await update({ snapshotError: `${err}` });
  }

  // diff the snapshot against the live page with every differ. the CDX lookup above only gives us the
  // snapshot's link; following it to get the HTML is 1 more Wayback request (through the same queue)
  if (snapshot) {
    try {
      const snapshotHtml = await timed(times, 'snapshotDownload', () => fetchSnapshotHtml(snapshot));
      await update({ differMetrics: await timed(times, 'differs', async () => measureDiffers(snapshotHtml, liveHtml)) });
    } catch (err) {
      await update({ metricsError: `${err}` });
    }
  }

  // look up the latest snapshot of each L1 link, then diff the ones that have one (see lib/linkDiff.ts)
  const linksToLookUp = livePage.links.slice(0, MAX_LINKS);
  linksStart = performance.now();
  await update({ linksToLookUp, linkLookups: {}, linkDiffs: {} });

  if (USE_CONCURRENT) {
    await analyzeLinksConcurrent(linksToLookUp, analysis, update, isCurrent);
  } else {
    await analyzeLinksSequential(linksToLookUp, analysis, update, isCurrent);
  }
}

// run `fn`, recording how long it took (wall-clock) in times[step], even if it throws
async function timed<T>(times: Times, step: Exclude<keyof Times, 'total'>, fn: () => Promise<T>): Promise<T> {
  const t = performance.now();
  try {
    return await fn();
  } finally {
    times[step] = performance.now() - t;
  }
}

async function analyzeLinksSequential(
  linksToLookUp: string[],
  analysis: Analysis,
  update: (changes: Partial<Analysis>) => Promise<void>,
  isCurrent: () => boolean,
) {
  for (const link of linksToLookUp) {
    if (!isCurrent()) return;

    const startTime = performance.now();
    let result: LinkLookup;

    try {
      const snapshot = await findLatestSnapshot(link);
      result = { snapshot, durationMs: performance.now() - startTime };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      if (err instanceof WaybackRateLimitedError) {
        await update({ linkLookupsStopped: err.message });
        return;
      }
      result = { error: `${err}`, durationMs };
    }

    console.log('[RefDelta] link lookup', link, result);
    const updatedLookups = { ...analysis.linkLookups, [link]: result };
    const totalDurationMs = Object.values(updatedLookups).reduce((sum, r) => sum + r.durationMs, 0);
    await update({ linkLookups: updatedLookups, totalDurationMs });

    if ('snapshot' in result && result.snapshot) {
      const rateLimited = await diffAndSave(link, result.snapshot, analysis, update, isCurrent);
      if (rateLimited) return;
    }
  }
}

// diff one L1 link that has a snapshot and save the result; returns true if Wayback rate-limited us
// (then the caller should stop, like after a rate-limited lookup)
async function diffAndSave(
  link: string,
  snapshot: Snapshot,
  analysis: Analysis,
  update: (changes: Partial<Analysis>) => Promise<void>,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    const diff = await diffLink(link, snapshot);
    if (isCurrent()) await update({ linkDiffs: { ...analysis.linkDiffs, [link]: diff } });
    return false;
  } catch (err) {
    if (!(err instanceof WaybackRateLimitedError)) throw err; // diffLink returns other errors instead of throwing
    await update({ linkLookupsStopped: err.message });
    return true;
  }
}

// concurrent
// fire lookups in parallel with staggered starts to respect rate limit
// sends requests every 2.5s (24/min), but allows multiple to be ongoing at once
// (pacing uses waitForSlot, the same clock as every other Wayback request, incl. other tabs' runs)
async function analyzeLinksConcurrent(
  linksToLookUp: string[],
  analysis: Analysis,
  update: (changes: Partial<Analysis>) => Promise<void>,
  isCurrent: () => boolean,
) {
  const TIMEOUT_MS = 30000;
  let rateLimitHit = false;

  const lookUpLink = async (link: string) => {
    const startTime = performance.now();
    let result: LinkLookup;

    try {
      const snapshot = await findLatestSnapshotParallel(link, TIMEOUT_MS);
      result = { snapshot, durationMs: performance.now() - startTime };
    } catch (err) {
      const durationMs = performance.now() - startTime;
      if (err instanceof WaybackRateLimitedError) {
        rateLimitHit = true;
        await update({ linkLookupsStopped: err.message });
        return;
      }
      result = { error: `${err}`, durationMs };
    }

    if (!isCurrent() || rateLimitHit) return;
    const updatedLookups = { ...analysis.linkLookups, [link]: result };
    const totalDurationMs = Object.values(updatedLookups).reduce((sum, r) => sum + r.durationMs, 0);
    await update({ linkLookups: updatedLookups, totalDurationMs });

    // snapshot fetch goes through the Wayback queue, so it shares slots with the remaining lookups
    if ('snapshot' in result && result.snapshot) {
      if (await diffAndSave(link, result.snapshot, analysis, update, isCurrent)) rateLimitHit = true;
    }
  };

  // start one lookup per slot (without waiting for it to finish); stop starting new ones once
  // this run is outdated or a 429 came back
  const lookupPromises: Promise<void>[] = [];
  for (const link of linksToLookUp) {
    await waitForSlot();
    if (!isCurrent() || rateLimitHit) break;
    lookupPromises.push(lookUpLink(link));
  }

  await Promise.allSettled(lookupPromises);
}


async function findLatestSnapshotParallel(url: string, timeoutMs: number): Promise<Snapshot | null> {
  const query = new URL('https://web.archive.org/cdx/search/cdx');
  query.searchParams.set('url', url);
  query.searchParams.set('output', 'json');
  query.searchParams.set('limit', '-1');
  query.searchParams.set('fl', 'timestamp,original,statuscode');

  await throwIfPaused(); // don't send anything while paused from an earlier 429

  let res: Response;
  try {
    res = await fetch(query, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Wayback request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }

  if (res.status === 429) throw await pauseForRateLimit(res); // saves the pause for later requests

  if (!res.ok) throw new Error(`CDX request failed: ${res.status}`);

  const rows: string[][] = await res.json();
  if (rows.length < 2) return null;

  const [timestamp, original, statusCode] = rows[1] as [string, string, string];
  return { timestamp, statusCode, snapshotUrl: `https://web.archive.org/web/${timestamp}/${original}` };
}
