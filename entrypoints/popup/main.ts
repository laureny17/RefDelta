import './style.css';
import { analysisKey, type Analysis } from '@/lib/analysis';

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
  output.replaceChildren(
    title,
    snapshotLine(analysis),
    expandableList(`${livePage.links.length} links`, livePage.links, true),
    expandableList(`${livePage.malformed.length} malformed`, livePage.malformed, false),
  );
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
    const t = snapshot.timestamp;
    const a = document.createElement('a');
    a.href = snapshot.snapshotUrl;
    a.target = '_blank';
    a.textContent = `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
    el.append('Latest snapshot: ', a, ` (${snapshot.statusCode})`);
  }
  return el;
}

// TEMPORARY; for testing / minimal functionality purposes
function expandableList(label: string, items: string[], asLinks: boolean): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = label;
  const list = document.createElement('ol');
  for (const item of items) {
    const li = document.createElement('li');
    if (asLinks) {
      const a = document.createElement('a');
      a.href = item;
      a.target = '_blank';
      a.textContent = item;
      li.append(a);
    } else {
      li.textContent = item; // show malformed hrefs as plain text
    }
    list.append(li);
  }
  details.append(summary, list);
  return details;
}
