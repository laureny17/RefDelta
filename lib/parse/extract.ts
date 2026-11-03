// shared content parser: turns a page (live or Wayback snapshot) into the content we diff.
// every diff algorithm starts from the same PageContent, so differences in results come from
// the algorithm, not from parsing
//
// takes a Document (not an HTML string) so it works anywhere we can get one:
// the content script (the live page), DOMParser in a page/offscreen document, or linkedom in Node (benchmarks)

import { extractLinks } from './links';

export interface PageContent {
  url: string;
  title: string;
  text: string; // visible text, whitespace collapsed
  links: string[]; // outbound links (filtered + normalized; see links.ts)
  malformed: string[]; // hrefs that aren't valid URLs
}

// elements whose text isn't visible page content
const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template'];

// `pageUrl` is the page's real URL (for a snapshot: the original URL, not the web.archive.org one);
// links are resolved against it
export function extract(doc: Document, pageUrl: string): PageContent {
  // TODO: boilerplate removal (nav, header, footer, ads, Wayback's injected toolbar, ...)
  // TODO: keep block structure (paragraphs/headings) for line-level diffing?
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined; // clone so we don't modify the real page
  if (body) {
    for (const el of body.querySelectorAll(NON_CONTENT_TAGS.join(','))) el.remove();
  }
  const { links, malformed } = body ? extractLinks(body, pageUrl, baseUrl(doc, pageUrl)) : { links: [], malformed: [] };

  return {
    url: pageUrl,
    title: doc.title.trim(),
    // textContent instead of innerText: innerText needs layout, which Node (linkedom) doesn't have
    text: (body?.textContent ?? '').replace(/\s+/g, ' ').trim(),
    links,
    malformed,
  };
}

// the URL relative links are resolved against: the page's <base href> if it has one, else the page URL
function baseUrl(doc: Document, pageUrl: string): string {
  const href = doc.querySelector('base[href]')?.getAttribute('href');
  return href && URL.canParse(href, pageUrl) ? new URL(href, pageUrl).href : pageUrl;
}
