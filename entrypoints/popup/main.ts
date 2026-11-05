import './style.css';
import { analysisKey, type Analysis } from '@/lib/analysis';
import type { Image } from '@/lib/parse/extract';
import type { DifferMetrics } from '@/lib/metrics';
import type { Snapshot } from '@/lib/wayback';

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

  const toLookUp = analysis.linksToLookUp ?? [];
  const done = Object.keys(analysis.linkLookups ?? {}).length;
  const linksLabel = toLookUp.length
    ? `${livePage.links.length} links (looked up ${done}/${toLookUp.length})`
    : `${livePage.links.length} links`;

  output.replaceChildren(
    title,
    snapshotLine(analysis),
    timesSection(analysis),
    metricsSection(analysis, open), // stats from running each differ on the snapshot vs the live page
    expandableList('links', linksLabel, livePage.links.map((link) => linkItem(link, analysis)), open),
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
function timesSection({ times = {}, totalDurationMs }: Analysis): HTMLElement {
  const steps: [string, number | undefined, string][] = [
    ['total', times.total, 'since clicking Analyze'],
    ['page', times.page, 'reading + parsing the live page'],
    ['snapshot lookup', times.snapshotLookup, "asking Wayback if this page has a snapshot (and when it's from)"],
    ['snapshot download', times.snapshotDownload, "downloading the snapshot's HTML, incl. waiting for a rate-limit slot"],
    ['differs', times.differs, 'running every differ on snapshot vs live (breakdown below)'],
    ['link lookups + diffs', times.linkLookups, 'first L1 lookup started -> latest lookup/diff finished, incl. the waits between them'],
    // each lookup's own time, added up: skips the waits between them, so it's less than "link lookups"
    ['sum of per-link times', totalDurationMs, "each link's own response time, added up (not counting waits)"],
  ];
  const section = document.createElement('div');
  section.className = 'times';
  const heading = document.createElement('h3');
  heading.textContent = 'Time';
  const table = document.createElement('table');
  for (const [name, ms, description] of steps) {
    const row = table.insertRow();
    row.insertCell().textContent = name;
    row.insertCell().textContent = ms === undefined ? '-' : seconds(ms);
    row.insertCell().textContent = description;
  }
  section.append(heading, table);
  return section;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 1000 ? 2 : 1)}s`;
}

// one link in the list: the URL, then its Wayback lookup status
function linkItem(link: string, analysis: Analysis): (string | Node)[] {
  const a = plainLink(link);

  const lookup = analysis.linkLookups?.[link];
  let status: (string | Node)[];
  if (!analysis.linksToLookUp?.includes(link)) {
    status = ['not checked']; // beyond MAX_LINKS
  } else if (!lookup) {
    status = [analysis.linkLookupsStopped ? 'skipped' : 'pending...'];
  } else if ('error' in lookup) {
    status = [`lookup failed: ${lookup.error} (${lookup.durationMs.toFixed(0)}ms)`];
  } else if (!lookup.snapshot) {
    status = [`no snapshot (${lookup.durationMs.toFixed(0)}ms) — `, linkDiffStatus(link, analysis)];
  } else {
    status = [
      snapshotLink(lookup.snapshot),
      ` (${statusLabel(lookup.snapshot.statusCode)}, ${lookup.durationMs.toFixed(0)}ms) — `,
      linkDiffStatus(link, analysis),
    ];
  }
  return [a, ' — ', ...status];
}

// for a link with a snapshot: each differ's similarity (snapshot vs live), or why it wasn't diffed
function linkDiffStatus(link: string, analysis: Analysis): string {
  const diff = analysis.linkDiffs?.[link];
  // no result yet: still running, or never will be if lookups stopped (e.g. rate limit)
  if (!diff) return analysis.linkLookupsStopped ? 'not checked' : 'checking live page...';
  // couldn't fetch the live page (e.g. timeout) or the snapshot
  if ('error' in diff) return `check failed: ${diff.error}`;
  // link rot: page gone, site unreachable, or redirects to a different site (see rotReason in lib/linkDiff.ts)
  if ('rot' in diff) return `LINK ROT: ${diff.rot}`;
  const redirect = diff.live.redirectedTo ? ` (live page redirected to ${diff.live.redirectedTo})` : '';
  // live page is fine but not diffed (e.g. no snapshot, a PDF, or blocked)
  if ('skipped' in diff) return `not diffed: ${diff.skipped}${redirect}`;
  // diffed: one "<algorithm> <similarity> (label)" per differ, e.g. "myers-word 64% (major)" and "myers-block 95% (minor)"
  const results = diff.metrics.map((m) =>
    'error' in m
      ? `${m.algorithm} failed`
      : `${m.algorithm} ${(m.similarity * 100).toFixed(1)}%${m.label ? ` (${m.label})` : ''}`,
  );
  return `${results.join(' · ')}${redirect} (${(diff.durationMs / 1000).toFixed(1)}s)`;
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
      row.insertCell().textContent = `${ms.toFixed(1)} ms`;
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
