import './style.css';

// shape of what the content script sends back (see collectLinks in content.ts)
// TODO: change this interface as content script evolves!
interface AnalyzeResult {
  title: string;
  links: string[];
  malformed: string[];
}

// TODO: change extension to show results as overlay rather than through extension popup
const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <h1>RefDelta</h1>
  <button id="analyze" type="button">Analyze this page</button>
  <div id="output"></div>
`;

const output = document.querySelector<HTMLDivElement>('#output')!;

document.querySelector<HTMLButtonElement>('#analyze')!.addEventListener('click', async () => {
  output.textContent = 'Analyzing...';
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const result: AnalyzeResult = await browser.tabs.sendMessage(tab!.id!, { type: 'analyze' });
    const title = document.createElement('p');
    title.textContent = result.title;
    output.replaceChildren(
      title,
      expandableList(`${result.links.length} links`, result.links, true),
      expandableList(`${result.malformed.length} malformed`, result.malformed, false),
    );
  } catch (err) {
    output.textContent = `Could not analyze page: ${err}`;
  }
});

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
