// which part of the page an analysis covers (see AnalysisScope in lib/analysis.ts)

import { normalize } from '@/lib/parse/links';

// the (normalized) URLs of links that are at least partly on screen right now. read once when the analysis starts,
// so scrolling afterwards doesn't change what's analyzed
export function visibleLinkUrls(): Set<string> {
  const urls = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!URL.canParse(anchor.href) || !isOnScreen(anchor)) continue;
    urls.add(normalize(new URL(anchor.href)));
  }
  return urls;
}

// any of the element's boxes (one per line, for a link that wraps) overlaps the viewport
function isOnScreen(el: Element): boolean {
  return [...el.getClientRects()].some(
    (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth,
  );
}
