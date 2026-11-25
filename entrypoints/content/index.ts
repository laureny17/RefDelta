import './overlay.css'; // injected through the manifest (see overlay.css)
import { LINK_COUNTS_PORT, type AnalysisScope, type AnalysisUpdateMessage, type RunSettings } from '@/lib/analysis';
import { extract } from '@/lib/parse/extract';
import { LinkHighlights } from './highlights';
import { BlockPicker } from './picker';
import { linksInScope, watchLinkCounts } from './scope';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    const highlights = new LinkHighlights();
    const picker = new BlockPicker();

    // the popup's live link count for each scope (shown with an estimated time on its scope buttons)
    browser.runtime.onConnect.addListener((port) => {
      if (port.name === LINK_COUNTS_PORT) watchLinkCounts(port);
    });

    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // the background re-sends the analysis on every saved change
      if (msg.type === 'analysis-update') {
        highlights.update((msg as AnalysisUpdateMessage).analysis);
        return;
      }
      // Select scope: the popup's "Pick blocks" button. once the user confirms on the page, ask the background to
      // start the run (it reads the picked blocks back through 'analyze' below)
      if (msg.type === 'start-picking') {
        const settings = msg.settings as RunSettings;
        highlights.clear(); // the previous run's highlights would get in the way of picking
        picker.start(() => browser.runtime.sendMessage({ type: 'analyze-tab', scope: 'select', ...settings }));
        return;
      }
      // run on extension's Start button
      if (msg.type === 'analyze') {
        picker.stop(); // e.g. picking was started, then a run was started from the popup instead
        highlights.clear(); // so a re-run starts from the page without the previous run's overlay
        // parsing + link filtering live in lib/parse/ (shared with snapshot parsing)
        // TODO: this reads the open tab, i.e. the page AFTER its JavaScript ran (comments, related
        //       articles, etc. that scripts added), but snapshots are raw HTML from Wayback, i.e. BEFORE any JavaScript
        //       runs, so diffs could flag script-added content as changes. can alternatively fetch the live page's raw HTML instead, so
        //       both sides are read the same way, and set aside JS-added content somewhere else?
        const content = extract(document, location.href);
        // only the links in scope become L1 links (e.g. "visible": the ones on screen right now). the page's text is
        // still read whole, since the L0 page is diffed whole
        const scope: AnalysisScope = msg.scope === 'visible' || msg.scope === 'select' ? msg.scope : 'full';
        content.links = linksInScope(content.links, scope, picker.selection);
        console.log('[RefDelta]', content); // full parse output (blocks, text, links, ...) for debugging
        // + the page's HTML, for diffing against its snapshot (not stored; see background.ts)
        sendResponse({ ...content, html: document.documentElement.outerHTML });
        return true; // keep message channel open for sendResponse
      }
    });
  },
});
