import './style.css';
import { analysisKey, type Analysis } from '@/lib/analysis';
import type { Image } from '@/lib/parse/extract';
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
  const totalMs = analysis.totalDurationMs;
  let linksLabel = toLookUp.length
    ? `${livePage.links.length} links (looked up ${done}/${toLookUp.length})`
    : `${livePage.links.length} links`;
  if (totalMs !== undefined) {
    linksLabel += ` — Total: ${(totalMs / 1000).toFixed(1)}s`;
  }

  output.replaceChildren(
    title,
    snapshotLine(analysis),
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
    status = [`no snapshot (${lookup.durationMs.toFixed(0)}ms)`];
  } else {
    status = [snapshotLink(lookup.snapshot), ` (${statusLabel(lookup.snapshot.statusCode)}, ${lookup.durationMs.toFixed(0)}ms)`];
  }
  return [a, ' — ', ...status];
}

// one image in the list: its URL, then its alt text (if any)
function imageItem({ src, alt }: Image): (string | Node)[] {
  return alt ? [plainLink(src), ` — "${alt}"`] : [plainLink(src)];
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
