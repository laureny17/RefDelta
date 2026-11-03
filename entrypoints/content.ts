import { extract } from '@/lib/parse/extract';
import type { PageLinks } from '@/lib/analysis';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // run on extension's "Analyze" button
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'analyze') {
        // parsing + link filtering live in lib/parse/ (shared with snapshot parsing)
        const content = extract(document, location.href);
        console.log('[RefDelta]', content); // full parse output (blocks, text, links, ...) for debugging
        const { url, title, links, malformed } = content;
        const result: PageLinks = { url, title, links, malformed };
        sendResponse(result);
      }
    });
  },
});
