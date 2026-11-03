import { extract } from '@/lib/parse/extract';
import type { PageLinks } from '@/lib/analysis';

export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // run on extension's "Analyze" button
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'analyze') {
        // parsing + link filtering live in lib/parse/ (shared with snapshot parsing)
        const { url, title, links, malformed } = extract(document, location.href);
        const result: PageLinks = { url, title, links, malformed };
        console.log('[RefDelta]', result);
        sendResponse(result);
      }
    });
  },
});
