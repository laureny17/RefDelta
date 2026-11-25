import { ANALYSIS_SCOPES, analysisKey, CONFIG_KEY, type Analysis, type AnalysisScope, type AnalysisUpdateMessage, type AnalysisConfig, type LinkLookup, type Times } from '@/lib/analysis';
import { diffLink } from '@/lib/linkDiff';
import type { PageContent } from '@/lib/parse/extract';
import { DEFAULT_L0_ALGORITHM, DEFAULT_L1_ALGORITHM, L0_ALGORITHMS, L1_ALGORITHMS, measureL0Diffs } from '@/lib/metrics';
import { RunControl } from '@/lib/runControl';
import { fetchSnapshotHtml, findSnapshot, type Snapshot } from '@/lib/wayback';
import { WaybackRateLimitedError, waitForFreeSlot } from '@/lib/waybackRateLimit';

// the current analysis run for each tab
interface Run {
  runId: number;
  control: RunControl; // pause / resume / stop
  update: (changes: Partial<Analysis>) => Promise<void>; // saves changes to the run's results
}
const currentRun = new Map<number, Run>();
let nextRunId = 0;

// runs the analysis in the background so it keeps going after the popup closes
export default defineBackground(() => {
  // listen for message from the popup to trigger analysis
  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'analyze-tab') {
      const date = typeof msg.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(msg.date) ? msg.date : undefined;
      // unknown/missing names fall back to the defaults
      const l0Algorithm = L0_ALGORITHMS.includes(msg.l0Algorithm) ? msg.l0Algorithm : DEFAULT_L0_ALGORITHM;
      const l1Algorithm = L1_ALGORITHMS.includes(msg.l1Algorithm) ? msg.l1Algorithm : DEFAULT_L1_ALGORITHM;
      const scope: AnalysisScope = ANALYSIS_SCOPES.includes(msg.scope) ? msg.scope : 'full';
      analyzeTab(msg.tabId, date, scope, { l0Algorithm, l1Algorithm });
    } else if (msg.type === 'pause-tab' || msg.type === 'resume-tab' || msg.type === 'stop-tab') {
      controlTab(msg.tabId, msg.type);
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
  currentRun.get(tabId)?.control.stop(); // releases anything waiting on a pause
  currentRun.delete(tabId);
  browser.storage.session.remove(analysisKey(tabId));
}

// save a tab's results (for the popup, which watches storage) and send them to the tab (for the overlay's badges)
// TODO: both happen on every progress change; throttle if it gets expensive on pages with many links
async function save(tabId: number, analysis: Analysis) {
  await browser.storage.session.set({ [analysisKey(tabId)]: analysis });
  const message: AnalysisUpdateMessage = { type: 'analysis-update', analysis };
  // fails if the tab has no content script (e.g. a browser page) or is mid-navigation; the overlay just misses that update
  browser.tabs.sendMessage(tabId, message).catch(() => {});
}

// pause / resume / stop the tab's current run (from the popup's buttons)
async function controlTab(tabId: number, action: 'pause-tab' | 'resume-tab' | 'stop-tab') {
  const run = currentRun.get(tabId);
  if (!run) {
    // no run in memory (e.g. the service worker was restarted), so there's nothing to resume:
    // mark saved results as stopped so the popup doesn't stay stuck on paused/running
    const key = analysisKey(tabId);
    const saved = (await browser.storage.session.get(key))[key] as Analysis | undefined;
    if (saved && (saved.runState === 'running' || saved.runState === 'paused')) {
      await save(tabId, { ...saved, runState: 'stopped' });
    }
    return;
  }
  if (run.control.stopped) return;
  if (action === 'pause-tab') {
    run.control.pause();
    await run.update({ runState: 'paused' });
  } else if (action === 'resume-tab') {
    run.control.resume();
    await run.update({ runState: 'running' });
  } else {
    run.control.stop();
    await run.update({ runState: 'stopped' });
  }
}

// analyze a single tab, saving results to storage.session as they become available
// TEMPORARY: using storage.session for now;
// TODO: replace/complement with IndexedDB
async function analyzeTab(tabId: number, requestedDate: string | undefined, selectedScope: AnalysisScope, selected: Pick<AnalysisConfig, 'l0Algorithm' | 'l1Algorithm'>) {
  const key = analysisKey(tabId);
  const runId = ++nextRunId;
  currentRun.get(tabId)?.control.stop(); // a previous run on this tab (e.g. paused) stops starting new work
  const control = new RunControl(() => void browser.runtime.getPlatformInfo());
  // registered right away, so the previous run's in-flight requests stop saving immediately
  const run: Run = { runId, control, update: async () => {} }; // `update` is filled in once the results object exists
  currentRun.set(tabId, run);
  const isCurrent = () => currentRun.get(tabId)?.runId === runId;

  // extra settings from a benchmark run (set in storage by benchmark/playwright.ts), if any; its `algorithms`
  // overrides the popup's selected differs (the benchmark clicks the popup's Start button with the selects' defaults)
  const configData = await browser.storage.session.get(CONFIG_KEY);
  const config: AnalysisConfig = { ...selected, ...(configData[CONFIG_KEY] as Partial<AnalysisConfig> | undefined) };
  // a benchmark run always covers the full page (it clicks the popup's Start, whatever scope is selected there)
  const scope: AnalysisScope = configData[CONFIG_KEY] ? 'full' : selectedScope;

  // wall-clock time of each step (see Times); total and linkLookups are refreshed on every update
  const start = performance.now();
  let linksStart: number | undefined;
  const times: Times = {};

  // accumulated results; each update merges in new fields and re-saves the whole thing
  const analysis: Analysis = {
    runState: 'running',
    times,
    requestedDate,
    scope,
    l0Algorithm: config.l0Algorithm,
    l1Algorithm: config.l1Algorithm,
  };
  const update = async (changes: Partial<Analysis>) => {
    Object.assign(analysis, changes);
    times.total = performance.now() - start;
    if (linksStart !== undefined) times.linkLookups = performance.now() - linksStart;
    // only save if this run is still current (else outdated: tab navigated/closed, or Analyze re-clicked)
    if (isCurrent()) await save(tabId, analysis);
  };
  run.update = update;
  // a run that ends on its own is done (unless the user stopped it, which already saved 'stopped')
  const finish = (changes: Partial<Analysis> = {}) => update({ ...changes, ...(!control.stopped && { runState: 'done' }) });
  // replace the old results with this run's (so far empty) ones, so the popup sees it's running
  await update({});

  let livePage: PageContent;
  let liveHtml: string; // kept here only, not saved with the results (too big to re-save on every update)
  // try to get the page links from the content script
  try {
    ({ html: liveHtml, ...livePage } = await timed<PageContent & { html: string }>(times, 'page', () =>
      browser.tabs.sendMessage(tabId, { type: 'analyze', scope }),
    ));
  } catch (err) {
    await finish({ error: `Could not analyze page: ${err}` });
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
      await update({ differMetrics: await timed(times, 'differs', async () => measureL0Diffs(snapshotHtml, liveHtml, config)) });
    } catch (err) {
      await update({ metricsError: `${err}` });
    }
  }

  // pausing/stopping takes effect here at the earliest: the L0 page (a few requests) always finishes
  await control.waitIfPaused();
  if (control.stopped) return;

  // Anchor every L1 lookup to the actual L0 capture so all archived pages are from as close to
  // the same moment as Wayback can provide.
  // every L1 link, in page order (lookups are paced at 24/min, so a page with many links takes a while;
  // the popup shows progress + time left, and the user can pause/stop)
  const linksToLookUp = livePage.links;
  linksStart = performance.now();
  await update({ linksToLookUp, linkLookups: {}, linkDiffs: {} });

  await analyzeLinks(linksToLookUp, snapshot?.timestamp, analysis, update, isCurrent, config, control);
  await finish();
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
  config: AnalysisConfig,
): Promise<boolean> {
  try {
    const diff = await diffLink(link, snapshot, (phase) => void update({ linkPhases: { ...analysis.linkPhases, [link]: phase } }), config);
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
  config: AnalysisConfig,
  control: RunControl,
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
      if (await diffAndSave(link, result.snapshot, analysis, update, isCurrent, config)) rateLimitHit = true;
    }
  };

  // start one lookup per free slot (without waiting for it to finish); stop starting new ones once
  // this run is outdated, stopped, or a 429 came back. while paused, wait (lookups already sent keep going)
  const lookupPromises: Promise<void>[] = [];
  for (const link of linksToLookUp) {
    await waitForFreeSlot('lookup');
    await control.waitIfPaused();
    if (!isCurrent() || control.stopped || rateLimitHit) break;
    lookupPromises.push(lookUpLink(link));
  }

  await Promise.allSettled(lookupPromises);
}
