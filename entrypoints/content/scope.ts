// which part of the page an analysis covers (see AnalysisScope in lib/analysis.ts)

import type { AnalysisScope, LinkCounts } from '@/lib/analysis';
import { extract } from '@/lib/parse/extract';
import { normalize } from '@/lib/parse/links';

// re-parse the page at most this often while it's changing (e.g. still loading, or a script adding content)
const REPARSE_INTERVAL_MS = 300;

// while the popup is open: send it each scope's link count, then again whenever scrolling/resizing changes what's
// on screen (at most once per frame), or the page's content changes (re-parsed at most every REPARSE_INTERVAL_MS).
// re-parsing matters if the popup opens while the page is still loading: a parse from then would only know the
// links that existed at that moment. stops when the popup closes (the connection disconnects)
export function watchLinkCounts(port: Browser.runtime.Port) {
  const parse = () => extract(document, location.href).links;
  let links = parse();
  let last = '';
  const send = () => {
    const counts: LinkCounts = { visible: linksInScope(links, 'visible').length, full: links.length };
    const key = JSON.stringify(counts);
    if (key !== last) port.postMessage(counts); // only when a count actually changed
    last = key;
  };

  // scrolling / resizing: only which links are on screen changed
  let framePending = false;
  const onScroll = () => {
    if (framePending) return;
    framePending = true;
    requestAnimationFrame(() => {
      framePending = false;
      send();
    });
  };

  // content added/removed: the links themselves may have changed, so parse again shortly after. not reset by later
  // changes, so a page that never stops changing (carousels, ads) still gets re-parsed every REPARSE_INTERVAL_MS.
  // (our own overlay is outside <body>, so it doesn't trigger this)
  let reparseTimer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => {
    reparseTimer ??= setTimeout(() => {
      reparseTimer = undefined;
      links = parse();
      send();
    }, REPARSE_INTERVAL_MS);
  });

  send();
  window.addEventListener('scroll', onScroll, { capture: true, passive: true }); // capture: incl. inner scrolling areas
  window.addEventListener('resize', onScroll);
  observer.observe(document.body, { childList: true, subtree: true });
  port.onDisconnect.addListener(() => {
    window.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', onScroll);
    observer.disconnect();
    clearTimeout(reparseTimer);
  });
}

// the page's L1 links that fall within `scope`. used when a run starts and for the link counts shown before one,
// so the counts match what a run would check. `blocks`: for 'select', the picked blocks
export function linksInScope(links: string[], scope: AnalysisScope, blocks: Element[] = []): string[] {
  if (scope === 'full') return links;
  const inScope = scope === 'visible' ? visibleLinkUrls() : linkUrlsIn(blocks);
  return links.filter((link) => inScope.has(link));
}

// the (normalized) URLs of links inside any of `blocks` (or that are one of them)
function linkUrlsIn(blocks: Element[]): Set<string> {
  const urls = new Set<string>();
  for (const block of blocks) {
    const anchors = [...block.querySelectorAll<HTMLAnchorElement>('a[href]')];
    if (block instanceof HTMLAnchorElement) anchors.push(block);
    for (const anchor of anchors) if (URL.canParse(anchor.href)) urls.add(normalize(new URL(anchor.href)));
  }
  return urls;
}

// the (normalized) URLs of links that are at least partly on screen right now. a run reads this once when it
// starts, so scrolling afterwards doesn't change what it analyzes
function visibleLinkUrls(): Set<string> {
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
