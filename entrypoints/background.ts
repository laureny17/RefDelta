import { analysisKey, type Analysis, type LinkLookup, type PageLinks } from '@/lib/analysis';
import { findLatestSnapshot } from '@/lib/wayback';
import { WaybackRateLimitedError } from '@/lib/waybackQueue';

// max number of L1 links to look up per page (pretty arbitrarily chosen for now)
// note that waybackFetch is limited to ~20 Wayback requests/min (see waybackQueue.ts)
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

  // look up the latest snapshot of each L1 link, one at a time (paced by the Wayback queue)
  const linksToLookUp = livePage.links.slice(0, MAX_LINKS);
  await update({ linksToLookUp, linkLookups: {} });
  for (const link of linksToLookUp) {
    if (!isCurrent()) return; // stop if this run is outdated (tab navigated/closed, or Analyze re-clicked)

    let result: LinkLookup;
    try {
      result = { snapshot: await findLatestSnapshot(link) };
    } catch (err) {
      if (err instanceof WaybackRateLimitedError) {
        // if we hit rate limit, every remaining lookup would fail too, so stop here
        await update({ linkLookupsStopped: err.message });
        return;
      }
      result = { error: `${err}` }; // e.g. timeout or 5xx; report it and move on to the next link
    }
    console.log('[RefDelta] link lookup', link, result);
    await update({ linkLookups: { ...analysis.linkLookups, [link]: result } });
  }
}
