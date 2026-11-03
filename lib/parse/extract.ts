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
  blocks: string[]; // text of each block (paragraph, heading, list item, ...), for line-level diffing
  text: string; // all visible text: blocks joined with "\n"
  links: string[]; // outbound links (filtered + normalized; see links.ts)
  malformed: string[]; // hrefs that aren't valid URLs
}

// elements whose text isn't visible page content
const NON_CONTENT_TAGS = ['script', 'style', 'noscript', 'template'];

// `pageUrl` is the page's real URL (for a snapshot: the original URL, not the web.archive.org one);
// links are resolved against it
export function extract(doc: Document, pageUrl: string): PageContent {
  // TODO: boilerplate removal (nav, header, footer, ads, Wayback's injected toolbar, ...)
  const body = doc.body?.cloneNode(true) as HTMLElement | undefined; // clone so we don't modify the real page
  if (body) {
    for (const el of body.querySelectorAll(NON_CONTENT_TAGS.join(','))) el.remove();
  }
  const blocks = body ? toBlocks(body) : [];
  const { links, malformed } = body ? extractLinks(body, pageUrl, baseUrl(doc, pageUrl)) : { links: [], malformed: [] };

  return { url: pageUrl, title: doc.title.trim(), blocks, text: blocks.join('\n'), links, malformed };
}

// elements that start a new line of text when rendered
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
]);

// split the text into blocks, one per paragraph/heading/list item/etc., whitespace collapsed
// (walks text nodes instead of using innerText: innerText needs layout, which Node (linkedom) doesn't have)
// TODO: <pre> whitespace gets collapsed too; preserve it if we diff code blocks
function toBlocks(root: Element): string[] {
  const blocks: string[] = [];
  let current = '';
  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
    current = '';
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) { // text node
      current += node.textContent;
      return;
    }
    if (node.nodeType !== 1) return; // skip comments etc.; 1 = element
    const isBlock = BLOCK_TAGS.has((node as Element).tagName.toLowerCase());
    if (isBlock) flush();
    for (const child of node.childNodes) walk(child);
    if (isBlock) flush();
  };
  walk(root);
  flush();
  return blocks;
}

// the URL relative links are resolved against: the page's <base href> if it has one, else the page URL
function baseUrl(doc: Document, pageUrl: string): string {
  const href = doc.querySelector('base[href]')?.getAttribute('href');
  return href && URL.canParse(href, pageUrl) ? new URL(href, pageUrl).href : pageUrl;
}
