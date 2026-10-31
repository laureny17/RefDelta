import { analysisKey, type Analysis, type LinkLookup, type PageLinks } from '@/lib/analysis';
import { findLatestSnapshot, type Snapshot } from '@/lib/wayback';
import { WaybackRateLimitedError } from '@/lib/waybackQueue';

// max number of L1 links to look up per page (pretty arbitrarily chosen for now)
// note that waybackFetch is limited to ~20 Wayback requests/min (see waybackQueue.ts)
// TODO: which links should we analyze? should there be a "smart" way to determine which ones to look into, if we're being selective?
//       should we even cap? should we look into distributing work so we don't face rate-limiting issues?
const MAX_LINKS = 50;

// Set to true to use concurrent lookups (all fired at once, paced by queue)
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

  // accumulated results; each update merges in new fields and re-saves the whole thing
  const analysis: Analysis = {};
  const update = async (changes: Partial<Analysis>) => {
    Object.assign(analysis, changes);
    // only save if this run is still current (else outdated: tab navigated/closed, or Analyze re-clicked)
    if (isCurrent()) await browser.storage.session.set({ [key]: analysis });
  };

  let livePage: PageLinks;
  // try to get the page links from the content script
  try {
    livePage = await browser.tabs.sendMessage(tabId, { type: 'analyze' });
  } catch (err) {
    await update({ error: `Could not analyze page: ${err}` });
    return;
  }
  await update({ livePage }); // links ready; snapshot still pending

  // try to find the latest Wayback snapshot for the page
  try {
    await update({ snapshot: await findLatestSnapshot(livePage.url) });
  } catch (err) {
    await update({ snapshotError: `${err}` });
  }

  // look up the latest snapshot of each L1 link
  const linksToLookUp = livePage.links.slice(0, MAX_LINKS);
  await update({ linksToLookUp, linkLookups: {} });

  if (USE_CONCURRENT) {
    await analyzeLinksConcurrent(linksToLookUp, analysis, update, isCurrent);
  } else {
    await analyzeLinksSequential(linksToLookUp, analysis, update, isCurrent);
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
  }
}

// concurrent 
// fire lookups in parallel with staggered starts to respect rate limit
// sends requests every 2.5s (24/min), but allows multiple to be ongoing at once
async function analyzeLinksConcurrent(
  linksToLookUp: string[],
  analysis: Analysis,
  update: (changes: Partial<Analysis>) => Promise<void>,
  isCurrent: () => boolean,
) {
  const MIN_INTERVAL_MS = 2500; 
  const TIMEOUT_MS = 30000; 
  let rateLimitHit = false;

  const lookupPromises = linksToLookUp.map(async (link, index) => {
    const delay = index * MIN_INTERVAL_MS;
    await new Promise((resolve) => setTimeout(resolve, delay));

    if (!isCurrent() || rateLimitHit) return;

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
  });

  await Promise.allSettled(lookupPromises);
}


async function findLatestSnapshotParallel(url: string, timeoutMs: number): Promise<Snapshot | null> {
  const query = new URL('https://web.archive.org/cdx/search/cdx');
  query.searchParams.set('url', url);
  query.searchParams.set('output', 'json');
  query.searchParams.set('limit', '-1');
  query.searchParams.set('fl', 'timestamp,original,statuscode');

  let res: Response;
  try {
    res = await fetch(query, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Wayback request timed out after ${timeoutMs / 1000}s`);
    }
    throw err;
  }

  if (res.status === 429) {
    const blockedUntil = Date.now() + 10 * 60 * 1000; // 10 min default
    throw new WaybackRateLimitedError(blockedUntil);
  }

  if (!res.ok) throw new Error(`CDX request failed: ${res.status}`);

  const rows: string[][] = await res.json();
  if (rows.length < 2) return null;

  const [timestamp, original, statusCode] = rows[1] as [string, string, string];
  return { timestamp, statusCode, snapshotUrl: `https://web.archive.org/web/${timestamp}/${original}` };
}
