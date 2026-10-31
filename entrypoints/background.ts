import { analysisKey, type Analysis, type PageLinks } from '@/lib/analysis';
import { findLatestSnapshot } from '@/lib/wayback';

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
  const save = async (analysis: Analysis) => {
    if (currentRun.get(tabId) !== runId) return; // superseded; drop stale results
    await browser.storage.session.set({ [key]: analysis });
  };

  let livePage: PageLinks;
  // try to get the page links from the content script
  try {
    livePage = await browser.tabs.sendMessage(tabId, { type: 'analyze' });
  } catch (err) {
    await save({ error: `Could not analyze page: ${err}` });
    return;
  }
  await save({ livePage }); // links ready; snapshot still pending

  // try to find the latest Wayback snapshot for the page
  try {
    await save({ livePage, snapshot: await findLatestSnapshot(livePage.url) });
  } catch (err) {
    await save({ livePage, snapshotError: `${err}` });
  }
}
