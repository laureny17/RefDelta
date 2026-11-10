import { analysisKey, type Analysis, type LinkLookup, type Times } from '@/lib/analysis';
import { diffLink } from '@/lib/linkDiff';
import type { PageContent } from '@/lib/parse/extract';
import { measureL0Diffs } from '@/lib/metrics';
import { fetchSnapshotHtml, findSnapshot, type Snapshot } from '@/lib/wayback';
import { WaybackRateLimitedError, waitForFreeSlot } from '@/lib/waybackRateLimit';

// max number of L1 links to look up per page (pretty arbitrarily chosen for now)
// note that Wayback lookups are limited to 24/min (see waybackRateLimit.ts)
// TODO: which links should we analyze? should there be a "smart" way to determine which ones to look into, if we're being selective?
//       should we even cap? should we look into distributing work so we don't face rate-limiting issues?
const MAX_LINKS = 50;

// mapping for the current analysis run for each tab (tabId -> runId)
const currentRun = new Map<number, number>();
let nextRunId = 0;

// runs the analysis in the background so it keeps going after the popup closes
export default defineBackground(() => {
  // listen for message from the popup to trigger analysis
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'analyze-tab') {
      const date = typeof msg.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.date) ? msg.date : undefined;
      analyzeTab(msg.tabId, date);
    }
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
async function analyzeTab(tabId: number, requestedDate?: string) {
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
  const analysis: Analysis = { times, requestedDate };
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

  // Find either the latest L0 snapshot or the one closest to the requested date. Noon makes a
  // date-only selection neutral with respect to captures earlier/later on that calendar day.
  let snapshot: Snapshot | null = null;
  try {
    const targetTimestamp = requestedDate ? `${requestedDate.replaceAll('-', '')}120000` : undefined;
    snapshot = await timed(times, 'snapshotLookup', () => findSnapshot(livePage.url, targetTimestamp));
    await update({ snapshot });
  } catch (err) {
    await update({ snapshotError: `${err}` });
  }

  // diff the snapshot against the live page with every differ. the CDX lookup above only gives us the
  // snapshot's link; following it to get the HTML is 1 more Wayback request (paced like the lookup)
  if (snapshot) {
    try {
      const snapshotHtml = await timed(times, 'snapshotDownload', () => fetchSnapshotHtml(snapshot));
      await update({ differMetrics: await timed(times, 'differs', async () => measureL0Diffs(snapshotHtml, liveHtml)) });
    } catch (err) {
      await update({ metricsError: `${err}` });
    }
  }

  // Anchor every L1 lookup to the actual L0 capture so all archived pages are from as close to
  // the same moment as Wayback can provide.
  const linksToLookUp = livePage.links.slice(0, MAX_LINKS);
  linksStart = performance.now();
  await update({ linksToLookUp, linkLookups: {}, linkDiffs: {} });

  await analyzeLinks(linksToLookUp, snapshot?.timestamp, analysis, update, isCurrent);
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

// check (+ diff, if it has a snapshot) one L1 link and save the result; returns true if Wayback rate-limited us
// (then the caller should stop, like after a rate-limited lookup)
async function diffAndSave(
  link: string,
  snapshot: Snapshot | null,
  analysis: Analysis,
  update: (changes: Partial<Analysis>) => Promise<void>,
  isCurrent: () => boolean,
): Promise<boolean> {
  try {
    const diff = await diffLink(link, snapshot, (phase) => void update({ linkPhases: { ...analysis.linkPhases, [link]: phase } }));
    if (isCurrent()) await update({ linkDiffs: { ...analysis.linkDiffs, [link]: diff } });
    return false;
  } catch (err) {
    if (!(err instanceof WaybackRateLimitedError)) throw err; // diffLink returns other errors instead of throwing
    await update({ linkLookupsStopped: err.message });
    return true;
  }
}

// look up + check every L1 link, starting one lookup per rate-limit slot without waiting for earlier ones to
// finish, so several can be in flight at once. every Wayback request (this run's and other tabs') goes through
// waybackFetch, which paces lookups (24/min) and snapshot downloads (~456/min) on separate clocks (see waybackRateLimit.ts)
async function analyzeLinks(
  linksToLookUp: string[],
  targetTimestamp: string | undefined,
  analysis: Analysis,
  update: (changes: Partial<Analysis>) => Promise<void>,
  isCurrent: () => boolean,
) {
  let rateLimitHit = false;

  const lookUpLink = async (link: string) => {
    const startTime = performance.now();
    let result: LinkLookup;

    try {
      // not awaited: the lookup has to take its rate-limit slot right away, or the loop below would see the
      // slot still free and start more lookups while this save is in progress
      void update({ linkPhases: { ...analysis.linkPhases, [link]: 'lookingUp' } });
      const snapshot = await findSnapshot(link, targetTimestamp);
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

    // check every looked-up link for link rot (and diff it if it has a snapshot); the snapshot fetch goes
    // through waybackFetch, on the download clock (so it doesn't hold up the remaining lookups)
    if ('snapshot' in result) {
      if (await diffAndSave(link, result.snapshot, analysis, update, isCurrent)) rateLimitHit = true;
    }
  };

  // start one lookup per free slot (without waiting for it to finish); stop starting new ones once
  // this run is outdated or a 429 came back
  const lookupPromises: Promise<void>[] = [];
  for (const link of linksToLookUp) {
    await waitForFreeSlot('lookup');
    if (!isCurrent() || rateLimitHit) break;
    lookupPromises.push(lookUpLink(link));
  }

  await Promise.allSettled(lookupPromises);
}
