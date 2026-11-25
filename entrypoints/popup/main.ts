import './style.css';
import { ANALYSIS_SCOPES, analysisKey, LINK_COUNTS_PORT, type Analysis, type AnalysisScope, type LinkCounts, type RunState } from '@/lib/analysis';
import { SHOW_DEV_METRICS } from '@/lib/devFlags';
import { DEFAULT_L0_ALGORITHM, DEFAULT_L1_ALGORITHM, L0_ALGORITHMS, L1_ALGORITHMS } from '@/lib/metrics';
import type { LinkDiff } from '@/lib/linkDiff';
import type { DifferMetrics } from '@/lib/metrics';
import type { Snapshot } from '@/lib/wayback';
import { LOOKUP_INTERVAL_MS } from '@/lib/waybackRateLimit';

// each L1 link's status, shown as a badge at the start of its line (and counted in the links heading, in this order).
// `kind` picks the badge color (see .link-status in style.css)
const STATUS_KINDS = {
  'waiting: lookup': 'waiting-lookup', // for a rate-limit slot
  'waiting: download': 'waiting-download', // for a rate-limit slot
  'looking up': 'active',
  'checking live': 'active',
  'downloading': 'active',
  'diffed': 'ok',
  'LINK ROT': 'rot',
  'no snapshot': 'skipped',
  'not diffed': 'skipped',
  'failed': 'error',
  'stopped': 'stopped', // lookups stopped (e.g. Wayback rate limit) before this link finished
} as const;
const STATUS_LABELS = Object.keys(STATUS_KINDS) as StatusLabel[];
type StatusLabel = keyof typeof STATUS_KINDS;

interface LinkStatus {
  label: StatusLabel;
  details: (string | Node)[]; // shown after the URL
}

// the popup is just the analysis controls; results will be shown on the page itself (overlay).
// with SHOW_DEV_METRICS on, the dev metrics are shown underneath the controls
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <h1>RefDelta</h1>
  <div class="controls">
    <label for="snapshot-date">Compare against date</label>
    <input id="snapshot-date" type="date" title="optional; leave empty for the latest snapshot">
    <label for="l0-algorithm">Page algorithm</label>
    <select id="l0-algorithm">${options(L0_ALGORITHMS)}</select>
    <label for="l1-algorithm">Link algorithm</label>
    <select id="l1-algorithm">${options(L1_ALGORITHMS)}</select>
  </div>
  <div class="scope" role="radiogroup" aria-label="What to analyze">
    <label><input type="radio" name="scope" value="visible"><span>Visible<small data-estimate="visible"></small></span></label>
    <label><input type="radio" name="scope" value="full"><span>Full page<small data-estimate="full"></small></span></label>
  </div>
  <p id="scope-warning" hidden></p>
  <div class="run-buttons">
    <button id="analyze" type="button">Start</button>
    <button id="pause" type="button" hidden>Pause</button>
    <button id="resume" type="button" hidden>Resume</button>
    <button id="stop" type="button" hidden>Stop</button>
  </div>
  <p id="progress" hidden></p>
  <div id="output"></div>
`;

const output = document.querySelector<HTMLDivElement>('#output')!;
const dateInput = document.querySelector<HTMLInputElement>('#snapshot-date')!;
const l0Select = document.querySelector<HTMLSelectElement>('#l0-algorithm')!;
const l1Select = document.querySelector<HTMLSelectElement>('#l1-algorithm')!;
l0Select.value = DEFAULT_L0_ALGORITHM;
l1Select.value = DEFAULT_L1_ALGORITHM;
const startButton = document.querySelector<HTMLButtonElement>('#analyze')!; // id kept: benchmark/playwright.ts clicks it
const pauseButton = document.querySelector<HTMLButtonElement>('#pause')!;
const resumeButton = document.querySelector<HTMLButtonElement>('#resume')!;
const stopButton = document.querySelector<HTMLButtonElement>('#stop')!;
const scopeInputs = [...document.querySelectorAll<HTMLInputElement>('input[name="scope"]')];
const progress = document.querySelector<HTMLParagraphElement>('#progress')!;

// one <option> per algorithm name
function options(names: string[]): string {
  return names.map((name) => `<option value="${name}">${name}</option>`).join('');
}

// display of results in popup is a TEMPORARY feature
// background script does the work and saves results to storage.session -> closing the popup doesn't stop analysis
// TEMPORARY: using storage.session for now;
// TODO: replace/complement with IndexedDB

// Check if tab ID is provided in URL (for programmatic access, e.g. from benchmark)
const urlParams = new URLSearchParams(window.location.search);
const tabIdFromUrl = urlParams.get('tab');
let tabId: number;
if (tabIdFromUrl) {
  tabId = parseInt(tabIdFromUrl, 10);
} else {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  tabId = tab!.id!;
}
const key = analysisKey(tabId);

// which part of the page to analyze: the last one picked (default: what's on screen)
const SCOPE_KEY = 'popupScope'; // storage.local: a popup convenience only, not part of any results
const savedScope = (await browser.storage.local.get(SCOPE_KEY))[SCOPE_KEY] as AnalysisScope | undefined;
setScope(savedScope && ANALYSIS_SCOPES.includes(savedScope) ? savedScope : 'visible');
const scopeWarning = document.querySelector<HTMLParagraphElement>('#scope-warning')!;
let linkCounts: LinkCounts | undefined; // filled in once the page answers (below)
const LONG_RUN_MS = 2 * 60 * 1000; // warn before a full-page run longer than this
let isRunActive = false; // set by renderRunControls; the warning is only for starting a run

// show any results from an earlier run of the same page on this tab
const stored = await browser.storage.session.get(key);
render(stored[key] as Analysis | undefined);

// re-render whenever the background script re-saves progress
browser.storage.session.onChanged.addListener((changes) => {
  if (changes[key]) render(changes[key].newValue as Analysis | undefined);
});

for (const input of scopeInputs) {
  input.addEventListener('change', () => {
    browser.storage.local.set({ [SCOPE_KEY]: selectedScope() });
    renderScopeWarning();
  });
}

// each scope's link count + estimated time, kept up to date while the popup is open (the page re-sends the counts as
// it's scrolled; see watchLinkCounts in entrypoints/content/scope.ts). the connection closes with the popup.
// on pages without our content script (e.g. browser pages) nothing answers, so the estimates stay blank
const countsPort = browser.tabs.connect(tabId, { name: LINK_COUNTS_PORT });
countsPort.onMessage.addListener((counts: LinkCounts) => {
  linkCounts = counts;
  for (const scope of ANALYSIS_SCOPES) {
    document.querySelector<HTMLElement>(`[data-estimate="${scope}"]`)!.textContent = estimateText(counts[scope]);
  }
  renderScopeWarning();
});
countsPort.onDisconnect.addListener(() => void browser.runtime.lastError); // no content script: leave estimates blank

// e.g. "12 links · ~30 s": each link takes one Wayback lookup (24/min), the bottleneck (see progress estimate below)
function estimateText(links: number): string {
  if (links === 0) return 'no links';
  return `${links} link${links === 1 ? '' : 's'} · ~${roughDuration(links * LOOKUP_INTERVAL_MS)}`;
}

// warn before a long full-page run (it can still be paused or stopped)
function renderScopeWarning() {
  const ms = linkCounts && !isRunActive && selectedScope() === 'full' ? linkCounts.full * LOOKUP_INTERVAL_MS : 0;
  scopeWarning.hidden = ms <= LONG_RUN_MS;
  scopeWarning.textContent = `Checking every link will take about ${roughDuration(ms)}. You can pause or stop anytime.`;
}

function selectedScope(): AnalysisScope {
  return (scopeInputs.find((input) => input.checked)?.value ?? 'visible') as AnalysisScope;
}

function setScope(scope: AnalysisScope) {
  for (const input of scopeInputs) input.checked = input.value === scope;
}

startButton.addEventListener('click', () => {
  output.textContent = 'Analyzing...';
  browser.runtime.sendMessage({
    type: 'analyze-tab',
    tabId,
    scope: selectedScope(),
    date: dateInput.value || undefined,
    l0Algorithm: l0Select.value,
    l1Algorithm: l1Select.value,
  });
});

// the background saves the new runState right away, and render() swaps the buttons when it arrives
pauseButton.addEventListener('click', () => browser.runtime.sendMessage({ type: 'pause-tab', tabId }));
resumeButton.addEventListener('click', () => browser.runtime.sendMessage({ type: 'resume-tab', tabId }));
stopButton.addEventListener('click', () => browser.runtime.sendMessage({ type: 'stop-tab', tabId }));

// buttons follow the SAVED run state (not anything local to the popup), so reopening the popup mid-run shows the right ones:
//   no run / done / stopped: Start; running: Pause + Stop; paused: Resume + Stop
// the date + algorithm selects are locked during a run, so they always match what's running
function renderRunControls(runState: RunState | undefined) {
  const active = runState === 'running' || runState === 'paused';
  startButton.hidden = active;
  pauseButton.hidden = runState !== 'running';
  resumeButton.hidden = runState !== 'paused';
  stopButton.hidden = !active;
  for (const input of [dateInput, l0Select, l1Select, ...scopeInputs]) input.disabled = active;
  isRunActive = active;
}

// L1 progress, e.g. "38/50 links · ~30 s left".
// shown whenever there are links to check, with or without SHOW_DEV_METRICS
function renderProgress(analysis: Analysis | undefined) {
  const links = analysis?.linksToLookUp;
  progress.hidden = !links;
  if (!analysis || !links) return;
  const { linkPhases = {}, linkLookups = {}, linkDiffs = {} } = analysis;

  // a link is finished once it has a diff result, or its lookup failed (then it's never diffed)
  const finished = links.filter((link) => linkDiffs[link] || 'error' in (linkLookups[link] ?? {})).length;
  let text = `${finished}/${links.length} links`;

  if (analysis.runState === 'paused') text += ' · paused';
  else if (analysis.runState === 'running') {
    // each link waits for one lookup slot (24/min), which is the bottleneck; the rest (live fetch, snapshot download
    // at ~456/min, diffing) mostly overlaps with later lookups. optimistic: other tabs' lookups share the same clock
    const notStarted = links.filter((link) => !linkPhases[link]).length;
    text += notStarted > 0 ? `, ~${roughDuration(notStarted * LOOKUP_INTERVAL_MS)} left` : ' · finishing…';
  }
  progress.textContent = text;
}

// "~40 s" under a minute (to the nearest 5s), otherwise whole minutes rounded up ("~7 min")
function roughDuration(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.ceil(s / 60)} min`;
}

function render(analysis: Analysis | undefined) {
  renderRunControls(analysis?.runState);
  renderProgress(analysis);
  if (!analysis) return; // not analyzed yet
  // Don't overwrite a date while the user is editing it as background progress re-renders.
  if (document.activeElement !== dateInput) dateInput.value = analysis.requestedDate ?? '';
  // show which differs the shown results came from
  if (analysis.l0Algorithm && document.activeElement !== l0Select) l0Select.value = analysis.l0Algorithm;
  if (analysis.l1Algorithm && document.activeElement !== l1Select) l1Select.value = analysis.l1Algorithm;
  if (analysis.scope) setScope(analysis.scope);
  renderScopeWarning();
  if (analysis.error) {
    output.textContent = analysis.error;
    return;
  }
  // everything below is dev-only output (results will move to the overlay)
  if (!SHOW_DEV_METRICS) {
    output.replaceChildren();
    return;
  }
  if (!analysis.livePage) {
    output.textContent = 'Analyzing...'; // run started; live page not parsed yet
    return;
  }
  // re-renders on every saved result, so remember which <details> were expanded
  const open = new Set([...output.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.key));
  output.replaceChildren(devMetricsBox(analysis, analysis.livePage.links, open));
}

// DEV ONLY (SHOW_DEV_METRICS): overall metrics for the run, as one table of grouped rows
// (time per step, the L0 differ's stats, L1 totals), then collapsible L0 diff preview(s) + the per-link list.
// per-link metrics will move next to each link's badge in the overlay
function devMetricsBox(analysis: Analysis, links: string[], open: Set<string | undefined>): HTMLElement {
  const { times = {}, totalDurationMs, linkDiffs = {} } = analysis;
  const box = document.createElement('section');
  box.className = 'dev-metrics';
  const table = document.createElement('table');

  addGroup(table, 'Snapshot', [['L0 snapshot', snapshotText(analysis)]]);

  // wall-clock time of each step (see Times in lib/analysis.ts); "–" = not done yet
  addGroup(table, 'Time', [
    ['total', ms(times.total)],
    ['live page parse', ms(times.page)],
    ['snapshot lookup', ms(times.snapshotLookup)],
    ['snapshot download', ms(times.snapshotDownload)], // incl. waiting for a rate-limit slot
    ['L0 diff', ms(times.differs)],
    ['L1 stage', ms(times.linkLookups)], // first L1 lookup started -> latest lookup/diff finished, incl. waits
  ]);

  addGroup(table, `L0 · ${analysis.l0Algorithm ?? '?'}`, l0Rows(analysis));

  // L1 totals: links by status, then time per link (diffed links only, since others skip the download + compute)
  const statuses = links.map((link) => linkStatus(link, analysis));
  const counts = STATUS_LABELS.map((label) => [label, statuses.filter((s) => s.label === label).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label.toLowerCase()}`);
  const diffed = Object.values(linkDiffs).filter((d) => 'metrics' in d);
  const computeTotal = diffed.reduce((sum, d) => sum + computeMs(d), 0);
  const l1Rows: Row[] = [
    ['links', `${links.length}${counts.length ? `: ${counts.join(' · ')}` : ''}`],
    // each lookup's own response time, added up (lookups overlap, so this isn't time waited)
    ['lookups (summed)', ms(totalDurationMs)],
    // network time varies run to run, so compute is the number to compare L1 differs with
    ['compute (summed)', ms(computeTotal)],
    ['avg per diffed link', diffed.length
      ? `${duration(diffed.reduce((sum, d) => sum + d.durationMs, 0) / diffed.length)} total · ${duration(computeTotal / diffed.length)} compute`
      : '–'],
  ];
  if (analysis.linkLookupsStopped) l1Rows.push(['stopped', analysis.linkLookupsStopped]);
  addGroup(table, `L1 · ${analysis.l1Algorithm ?? '?'}`, l1Rows);

  box.append(
    table,
    ...diffPreviews(analysis, open),
    expandableList('links', `${links.length} links`, links.map((link, i) => linkItem(link, statuses[i]!)), open),
  );
  return box;
}

// one row of the dev metrics table: a name, then its value
type Row = [string, string | Node];

// a heading row spanning both columns, then one row per [name, value]
function addGroup(table: HTMLTableElement, heading: string, rows: Row[]) {
  const th = document.createElement('th');
  th.colSpan = 2;
  th.textContent = heading;
  table.insertRow().append(th);
  for (const [name, value] of rows) {
    const row = table.insertRow();
    row.insertCell().textContent = name;
    row.insertCell().append(value);
  }
}

// a duration, or "–" if that step isn't done yet
function ms(value: number | undefined): string {
  return value === undefined ? '–' : duration(value);
}

// every time shown in the popup: ms under 1s, s from 1s up
function duration(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(1)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// time spent computing for one link (parse + similarity, all L1 differs), without network time
// (a differ whose similarity needs a full diff, e.g. Myers, computes it inside similarity, so it's counted there)
function computeMs(diff: LinkDiff): number {
  if (!('metrics' in diff)) return 0;
  return diff.metrics.reduce((sum, m) => ('error' in m ? sum : sum + m.timings.parseMs + m.timings.similarityMs), 0);
}

// one link in the list: its status badge (always first, so they line up), the URL, then the details
function linkItem(link: string, { label, details }: LinkStatus): (string | Node)[] {
  const badge = document.createElement('span');
  badge.className = `link-status ${STATUS_KINDS[label]}`;
  badge.textContent = label;
  return [badge, plainLink(link), ' — ', ...details];
}

// a link's status: its result if it has one, otherwise the step it's on (see LinkPhase in lib/analysis.ts)
function linkStatus(link: string, analysis: Analysis): LinkStatus {
  const { linkPhases = {}, linkLookups = {}, linkDiffs = {} } = analysis;
  // links that never got a result because lookups stopped (Wayback rate limit, or the user's stop button)
  const stopped = analysis.linkLookupsStopped ?? (analysis.runState === 'stopped' ? 'stopped by user' : undefined);
  // L1 lookups only start after the page's own snapshot lookup + diff
  if (!analysis.linksToLookUp) {
    return { label: 'waiting: lookup', details: ["waiting for the page's own snapshot + diff to finish first"] };
  }

  const phase = linkPhases[link];
  const lookup = linkLookups[link];
  if (!lookup) {
    // a lookup that was in flight when lookups stopped has its result dropped (see analyzeLinks in background.ts)
    if (stopped) return { label: 'stopped', details: [phase ? 'lookup sent, result dropped when lookups stopped' : 'lookups stopped before its turn'] };
    return phase
      ? { label: 'looking up', details: ['asking Wayback for the snapshot closest to the L0 snapshot'] }
      : { label: 'waiting: lookup', details: ['waiting for a rate-limit slot to look up its snapshot'] };
  }
  if ('error' in lookup) return { label: 'failed', details: [`snapshot lookup failed: ${lookup.error} (${duration(lookup.durationMs)})`] };

  // what the lookup found, shown before the rest of the details
  const found = lookup.snapshot
    ? [snapshotLink(lookup.snapshot), ` (${statusLabel(lookup.snapshot.statusCode)}, found in ${duration(lookup.durationMs)}) — `]
    : [`no snapshot (${duration(lookup.durationMs)}) — `];
  const withFound = (label: StatusLabel, detail: string): LinkStatus => ({ label, details: [...found, detail] });

  const diff = linkDiffs[link];
  if (!diff) {
    // the live check and an already-sent download keep going after lookups stop; a download still waiting for its slot doesn't
    if (phase === 'checkingLive' || phase === 'lookingUp') return withFound('checking live', 'fetching the live page');
    if (phase === 'downloadingSnapshot') return withFound('downloading', 'downloading the snapshot');
    if (stopped) return withFound('stopped', 'not diffed: lookups stopped');
    return withFound('waiting: download', 'waiting for a rate-limit slot to download the snapshot');
  }
  // couldn't fetch the live page (e.g. timeout) or the snapshot
  if ('error' in diff) return withFound('failed', `check failed: ${diff.error}`);
  // link rot: page gone or site unreachable (see rotReason in lib/linkDiff.ts)
  if ('rot' in diff) return withFound('LINK ROT', diff.rot);
  const redirect = diff.live.redirectedTo ? ` (live page redirected to ${diff.live.redirectedTo})` : '';
  // live page is fine but not diffed (e.g. no snapshot, a PDF, or blocked)
  if ('skipped' in diff) return withFound(lookup.snapshot ? 'not diffed' : 'no snapshot', `${diff.skipped}${redirect}`);
  // diffed: one "<algorithm> <similarity> (label)" per differ, e.g. "myers-word 64% (major)" and "myers-block 95% (minor)"
  const results = diff.metrics.map((m) =>
    'error' in m
      ? `${m.algorithm} failed`
      : `${m.algorithm} ${(m.similarity * 100).toFixed(1)}% (${m.label})`,
  );
  // (total time incl. network, time spent computing only)
  return withFound('diffed', `${results.join(' · ')}${redirect} (${duration(diff.durationMs)} total, ${duration(computeMs(diff))} computing)`);
}

// the L0 differ's stats (usually one differ; a benchmark config can run several), or why there aren't any (yet)
function l0Rows(analysis: Analysis): Row[] {
  if (!analysis.snapshot) {
    return [['status', analysis.snapshot === null || analysis.snapshotError ? 'no snapshot to compare against' : 'waiting for snapshot…']];
  }
  if (analysis.metricsError) return [['error', analysis.metricsError]];
  if (!analysis.differMetrics) return [['status', 'downloading snapshot + diffing…']];
  return analysis.differMetrics.flatMap((r): Row[] => {
    const name = (row: string) => (analysis.differMetrics!.length > 1 ? `${r.algorithm}: ${row}` : row);
    if ('error' in r) return [[name('error'), r.error]];
    return [
      [name('parse · diff · similarity'), `${duration(r.timings.parseMs)} · ${duration(r.timings.diffMs)} · ${duration(r.timings.similarityMs)}`],
      [name('diff size'), `${(r.sizeBytes / 1024).toFixed(1)} KB`],
      [name('similarity'), `${(r.similarity * 100).toFixed(1)}% (${r.label}; placeholder thresholds)`],
    ];
  });
}

// one collapsible preview of each L0 differ's diff: inserted text green, deleted red, unchanged dimmed (see style.css).
// TEMPORARY until the overlay highlights the L0 diff on the page itself
function diffPreviews(analysis: Analysis, open: Set<string | undefined>): HTMLElement[] {
  const ok = (analysis.differMetrics ?? []).filter((r): r is Extract<DifferMetrics, { timings: unknown }> => !('error' in r));
  return ok.map(({ algorithm, preview }) => {
    // nothing to expand (e.g. the differ has no preview()); "0 changed runs" would wrongly suggest nothing changed
    if (!preview.length) {
      const note = document.createElement('p');
      note.textContent = `${algorithm}: no preview`;
      return note;
    }
    const key = `preview-${algorithm}`; // keeps it expanded across re-renders, like expandableList
    const details = document.createElement('details');
    details.dataset.key = key;
    details.open = open.has(key);
    const summary = document.createElement('summary');
    summary.textContent = `L0 diff preview (${algorithm}): ${preview.filter((p) => p.op !== 'equal').length} changed runs`;
    const body = document.createElement('div');
    body.className = 'diff-preview';
    // each run of equal/inserted/deleted tokens becomes a span styled by its op
    for (const { op, text } of preview) {
      const span = document.createElement('span');
      span.className = op;
      span.textContent = text + ' ';
      body.append(span);
    }
    details.append(summary, body);
    return details;
  });
}

// a link that opens in a new tab, showing its URL
function plainLink(link: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = link;
  a.target = '_blank';
  a.textContent = link;
  return a;
}

// the L0 snapshot's date (linked) + status, or why there isn't one (yet)
function snapshotText({ snapshot, snapshotError, requestedDate }: Analysis): HTMLSpanElement {
  const el = document.createElement('span');
  if (snapshotError) {
    el.textContent = `lookup failed: ${snapshotError}`;
  } else if (snapshot === undefined) {
    el.textContent = 'looking up…';
  } else if (snapshot === null) {
    el.textContent = requestedDate ? `none found near ${requestedDate}` : 'none found';
  } else {
    el.append(
      requestedDate ? `closest to ${requestedDate}: ` : 'latest: ',
      snapshotLink(snapshot),
      ` (${statusLabel(snapshot.statusCode)})`,
    );
  }
  return el;
}

// CDX shows "-" for "revisit" captures: the Internet Archive found the page identical to one of
// its earlier captures and stored a pointer instead of a copy, so no status code was recorded
// TODO: how to handle non-200 / revisit captures ?
function statusLabel(statusCode: string): string {
  return statusCode === '-' ? 'unchanged since earlier capture' : statusCode;
}

// snapshot date (YYYY-MM-DD), linking to the archived page
function snapshotLink(snapshot: Snapshot): HTMLAnchorElement {
  const t = snapshot.timestamp;
  const a = document.createElement('a');
  a.href = snapshot.snapshotUrl;
  a.target = '_blank';
  a.textContent = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return a;
}

// TEMPORARY; for testing / minimal functionality purposes
// `key` identifies the list across re-renders (to keep it expanded); each item is the content of one <li>
function expandableList(
  key: string,
  label: string,
  items: (string | Node)[][],
  open: Set<string | undefined>,
): HTMLDetailsElement {
  const details = document.createElement('details');
  details.dataset.key = key;
  details.open = open.has(key);
  const summary = document.createElement('summary');
  summary.textContent = label;
  const list = document.createElement('ol');
  for (const item of items) {
    const li = document.createElement('li');
    li.append(...item);
    list.append(li);
  }
  details.append(summary, list);
  return details;
}
