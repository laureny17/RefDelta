import { extract } from '@/lib/parse/extract';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // run on extension's "Analyze" button
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'analyze') {
        // parsing + link filtering live in lib/parse/ (shared with snapshot parsing)
        // TODO: this reads the open tab, i.e. the page AFTER its JavaScript ran (comments, related
        //       articles, etc. that scripts added), but snapshots are raw HTML from Wayback, i.e. BEFORE any JavaScript
        //       runs, so diffs could flag script-added content as changes. can alternatively fetch the live page's raw HTML instead, so
        //       both sides are read the same way, and set aside JS-added content somewhere else?
        const content = extract(document, location.href);
        console.log('[RefDelta]', content); // full parse output (blocks, text, links, ...) for debugging
        // + the page's HTML, for diffing against its snapshot (not stored; see background.ts)
        sendResponse({ ...content, html: document.documentElement.outerHTML });
      }
    });
  },
});
