import './style.css';
import { analysisKey, type Analysis } from '@/lib/analysis';
import type { LinkDiff } from '@/lib/linkDiff';
import type { Image } from '@/lib/parse/extract';
import type { DifferMetrics } from '@/lib/metrics';
import type { Snapshot } from '@/lib/wayback';

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
  'not checked': 'stopped', // beyond the links we look up (MAX_LINKS in background.ts)
} as const;
const STATUS_LABELS = Object.keys(STATUS_KINDS) as StatusLabel[];
type StatusLabel = keyof typeof STATUS_KINDS;

interface LinkStatus {
  label: StatusLabel;
  details: (string | Node)[]; // shown after the URL
}

// TODO: change extension to show results as overlay rather than through extension popup
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <h1>RefDelta</h1>
  <button id="analyze" type="button">Analyze this page</button>
  <div id="output"></div>
`;

const output = document.querySelector<HTMLDivElement>('#output')!;

// display of results in popup is a TEMPORARY feature
// background script does the work and saves results to storage.session -> closing the popup doesn't stop analysis
// TEMPORARY: using storage.session for now;
// TODO: replace/complement with IndexedDB
const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
const tabId = tab!.id!;
const key = analysisKey(tabId);

// show any results from an earlier run of the same page on this tab
const stored = await browser.storage.session.get(key);
render(stored[key] as Analysis | undefined);

// re-render whenever the background script re-saves progress
browser.storage.session.onChanged.addListener((changes) => {
  if (changes[key]) render(changes[key].newValue as Analysis | undefined);
});

document.querySelector<HTMLButtonElement>('#analyze')!.addEventListener('click', () => {
  output.textContent = 'Analyzing...';
  browser.runtime.sendMessage({ type: 'analyze-tab', tabId });
});

function render(analysis: Analysis | undefined) {
  if (!analysis) return; // not analyzed yet
  if (analysis.error) {
    output.textContent = analysis.error;
    return;
  }
  const livePage = analysis.livePage!;
  const title = document.createElement('p');
  title.textContent = livePage.title;

  // re-renders on every saved result, so remember which lists were expanded
  const open = new Set(
    [...output.querySelectorAll<HTMLDetailsElement>('details[open]')].map((d) => d.dataset.key),
  );

  // links heading: how many links have each status, e.g. "50 links: 12 diffed · 2 link rot · 30 waiting: lookup"
  const statuses = livePage.links.map((link) => linkStatus(link, analysis));
  const counts = STATUS_LABELS.map((label) => [label, statuses.filter((s) => s.label === label).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${n} ${label.toLowerCase()}`);
  const linksLabel = `${livePage.links.length} links${counts.length ? `: ${counts.join(' · ')}` : ''}`;

  output.replaceChildren(
    title,
    snapshotLine(analysis),
    timesSection(analysis),
    metricsSection(analysis, open), // stats from running each differ on the snapshot vs the live page
    expandableList('links', linksLabel, livePage.links.map((link, i) => linkItem(link, statuses[i]!)), open),
    expandableList(
      'malformed',
      `${livePage.malformed.length} malformed`,
      livePage.malformed.map((href) => [href]), // show malformed hrefs as plain text
      open,
    ),
    // TEMPORARY: parser output, for testing extraction + boilerplate removal (see lib/parse/)
    expandableList('blocks', `${livePage.blocks.length} content blocks`, livePage.blocks.map((b) => [b]), open),
    expandableList('images', `${livePage.images.length} images`, livePage.images.map(imageItem), open),
    expandableList(
      'boilerplate-blocks',
      `${livePage.boilerplate.blocks.length} boilerplate blocks (removed)`,
      livePage.boilerplate.blocks.map((b) => [b]),
      open,
    ),
    expandableList(
      'boilerplate-links',
      `${livePage.boilerplate.links.length} boilerplate links (removed)`,
      livePage.boilerplate.links.map((link) => [plainLink(link)]),
      open,
    ),
    expandableList(
      'boilerplate-images',
      `${livePage.boilerplate.images.length} boilerplate images (removed)`,
      livePage.boilerplate.images.map(imageItem),
      open,
    ),
  );
  if (analysis.linkLookupsStopped) {
    const stopped = document.createElement('p');
    stopped.textContent = `Link lookups stopped: ${analysis.linkLookupsStopped}`;
    output.append(stopped);
  }
}

// TEMPORARY: wall-clock time of each step so far (see Times in lib/analysis.ts), one row per step; "-" = not done yet
function timesSection({ times = {}, totalDurationMs, linkDiffs = {} }: Analysis): HTMLElement {
  const linkComputeMs = Object.values(linkDiffs).reduce((sum, d) => sum + computeMs(d), 0);
  const steps: [string, number | undefined, string][] = [
    ['total', times.total, 'since clicking Analyze'],
    ['page', times.page, 'reading + parsing the live page'],
    ['snapshot lookup', times.snapshotLookup, "asking Wayback if this page has a snapshot (and when it's from)"],
    ['snapshot download', times.snapshotDownload, "downloading the snapshot's HTML, incl. waiting for a rate-limit slot"],
    ['differs', times.differs, "running every differ for this page on snapshot vs live (breakdown below)"],
    ['link lookups + diffs', times.linkLookups, 'first L1 lookup started -> latest lookup/diff finished, incl. the waits between them'],
    // each lookup's own time, added up: skips the waits between them, so it's less than "link lookups"
    ['sum of per-link times', totalDurationMs, "each link's own response time, added up (not counting waits)"],
    // leaves out network time (which varies run to run), so it's the number to compare L1 differs with
    ['L1 diff computing', linkComputeMs, 'parse + similarity for every L1 link and L1 differ, added up'],
  ];
  const section = document.createElement('div');
  section.className = 'times';
  const heading = document.createElement('h3');
  heading.textContent = 'Time';
  const table = document.createElement('table');
  for (const [name, ms, description] of steps) {
    const row = table.insertRow();
    row.insertCell().textContent = name;
    row.insertCell().textContent = ms === undefined ? '-' : duration(ms);
    row.insertCell().textContent = description;
  }
  section.append(heading, table);
  return section;
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
  const { linkPhases = {}, linkLookups = {}, linkDiffs = {}, linkLookupsStopped: stopped } = analysis;
  if (!analysis.linksToLookUp?.includes(link)) {
    return { label: 'not checked', details: [`only the first ${analysis.linksToLookUp?.length ?? 0} links are checked`] };
  }

  const phase = linkPhases[link];
  const lookup = linkLookups[link];
  if (!lookup) {
    // a lookup that was in flight when lookups stopped has its result dropped (see analyzeLinks in background.ts)
    if (stopped) return { label: 'stopped', details: [phase ? 'lookup sent, result dropped when lookups stopped' : 'lookups stopped before its turn'] };
    return phase
      ? { label: 'looking up', details: ['asking Wayback for its latest snapshot'] }
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
      : `${m.algorithm} ${(m.similarity * 100).toFixed(1)}%${m.label ? ` (${m.label})` : ''}`,
  );
  // (total time incl. network, time spent computing only)
  return withFound('diffed', `${results.join(' · ')}${redirect} (${duration(diff.durationMs)} total, ${duration(computeMs(diff))} computing)`);
}

// one image in the list: its URL, then its alt text (if any)
function imageItem({ src, alt }: Image): (string | Node)[] {
  return alt ? [plainLink(src), ` — "${alt}"`] : [plainLink(src)];
}

// TEMPORARY: differ metrics (each differ run on snapshot vs live page): a table of stats, then a collapsible preview of each algorithm's diff
function metricsSection(analysis: Analysis, open: Set<string | undefined>): HTMLElement {
  const section = document.createElement('div');
  section.className = 'differ-metrics';
  const heading = document.createElement('h3');
  heading.textContent = 'Differ metrics: snapshot vs live page';
  section.append(heading);

  // nothing to show yet (or ever, if there's no snapshot)
  if (!analysis.snapshot) {
    section.append(analysis.snapshot === null || analysis.snapshotError ? 'No snapshot to compare against' : 'Waiting for snapshot...');
    return section;
  }
  if (analysis.metricsError) {
    section.append(`Differ metrics failed: ${analysis.metricsError}`);
    return section;
  }
  if (!analysis.differMetrics) {
    section.append('Fetching snapshot + diffing...');
    return section;
  }

  // differs that ran without errors
  const ok = analysis.differMetrics.filter((r): r is Extract<DifferMetrics, { timings: unknown }> => !('error' in r));

  // one row per differ
  const table = document.createElement('table');
  table.innerHTML = '<tr><th>algorithm</th><th>parse</th><th>diff</th><th>similarity time</th><th>diff size</th><th>similarity</th><th>label</th></tr>';
  for (const r of analysis.differMetrics) {
    const row = table.insertRow();
    row.insertCell().textContent = r.algorithm;
    if ('error' in r) { // differ threw: show the error across the rest of the row
      const cell = row.insertCell();
      cell.colSpan = 6;
      cell.textContent = `error: ${r.error}`;
      continue;
    }
    for (const ms of [r.timings.parseMs, r.timings.diffMs, r.timings.similarityMs]) {
      row.insertCell().textContent = duration(ms);
    }
    row.insertCell().textContent = `${(r.sizeBytes / 1024).toFixed(1)} KB`;
    row.insertCell().textContent = `${(r.similarity * 100).toFixed(1)}%`;
    row.insertCell().textContent = r.label ?? '-'; // no classifier yet
  }
  section.append(table);

  // one collapsible diff preview per differ: inserted text green, deleted red, unchanged dimmed (see style.css)
  for (const r of ok) {
    const key = `preview-${r.algorithm}`; // keeps it expanded across re-renders, like expandableList
    const preview = r.preview ?? [];
    const changed = preview.filter((p) => p.op !== 'equal').length;
    const details = document.createElement('details');
    details.dataset.key = key;
    details.open = open.has(key);
    const summary = document.createElement('summary');
    summary.textContent = `${r.algorithm}: ${changed} changed runs`;
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
    section.append(details);
  }
  return section;
}

// a link that opens in a new tab, showing its URL
function plainLink(link: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.href = link;
  a.target = '_blank';
  a.textContent = link;
  return a;
}

function snapshotLine({ snapshot, snapshotError }: Analysis): HTMLParagraphElement {
  const el = document.createElement('p');
  if (snapshotError) {
    el.textContent = `Snapshot lookup failed: ${snapshotError}`;
  } else if (snapshot === undefined) {
    el.textContent = 'Looking up Wayback snapshot...';
  } else if (snapshot === null) {
    el.textContent = 'No Wayback snapshot found';
  } else {
    el.append('Latest snapshot: ', snapshotLink(snapshot), ` (${statusLabel(snapshot.statusCode)})`);
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
