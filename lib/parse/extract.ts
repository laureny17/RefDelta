// shared content parser: turns a page (live or Wayback snapshot) into the content we diff.
// every diff algorithm starts from the same PageContent, so differences in results come from
// the algorithm, not from parsing
//
// takes a Document (not an HTML string) so it works anywhere we can get one:
// the content script (the live page), DOMParser in a page/offscreen document, or linkedom in Node (benchmarks)

export interface PageContent {
  title: string;
  text: string; // visible text, whitespace collapsed
  // TODO: links (share the filtering in content.ts, which currently assumes the live page's `location`)
}

// elements whose text isn't visible page content
const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template'];

export function extract(doc: Document): PageContent {
  // TODO: boilerplate removal (nav, header, footer, ads, Wayback's injected toolbar, ...)
  // TODO: keep block structure (paragraphs/headings) for line-level diffing?
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined; // clone so we don't modify the real page
  if (body) {
    for (const el of body.querySelectorAll(NON_CONTENT_TAGS.join(','))) el.remove();
  }

  return {
    title: doc.title.trim(),
    // textContent instead of innerText: innerText needs layout, which Node (linkedom) doesn't have
    text: (body?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
}
