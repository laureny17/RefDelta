import './overlay.css'; // injected through the manifest (see overlay.css)
import type { AnalysisUpdateMessage } from '@/lib/analysis';
import { extract } from '@/lib/parse/extract';
import { LinkHighlights } from './highlights';
import { visibleLinkUrls } from './scope';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    const highlights = new LinkHighlights();

    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      // the background re-sends the analysis on every saved change
      if (msg.type === 'analysis-update') {
        highlights.update((msg as AnalysisUpdateMessage).analysis);
        return;
      }
      // run on extension's Start button
      if (msg.type === 'analyze') {
        highlights.clear(); // so a re-run starts from the page without the previous run's overlay
        // parsing + link filtering live in lib/parse/ (shared with snapshot parsing)
        // TODO: this reads the open tab, i.e. the page AFTER its JavaScript ran (comments, related
        //       articles, etc. that scripts added), but snapshots are raw HTML from Wayback, i.e. BEFORE any JavaScript
        //       runs, so diffs could flag script-added content as changes. can alternatively fetch the live page's raw HTML instead, so
        //       both sides are read the same way, and set aside JS-added content somewhere else?
        const content = extract(document, location.href);
        // "visible" scope: only the links on screen right now become L1 links (the page's text is still read whole,
        // since the L0 page is diffed whole)
        if (msg.scope === 'visible') {
          const visible = visibleLinkUrls();
          content.links = content.links.filter((link) => visible.has(link));
        }
        console.log('[RefDelta]', content); // full parse output (blocks, text, links, ...) for debugging
        // + the page's HTML, for diffing against its snapshot (not stored; see background.ts)
        sendResponse({ ...content, html: document.documentElement.outerHTML });
        return true; // keep message channel open for sendResponse
      }
    });
  },
});
