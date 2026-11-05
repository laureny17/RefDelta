// shared content parser: turns a page (live or Wayback snapshot) into the content we diff.
// every diff algorithm starts from the same PageContent, so differences in results come from
// the algorithm, not from parsing
//
// takes a Document (not an HTML string) so it works anywhere we can get one:
// the content script (the live page), DOMParser in a page/offscreen document, or linkedom in Node (benchmarks)

import { findBoilerplate } from './kohlschutter';
import { extractLinks } from './links';

export interface PageContent {
  url: string;
  title: string;
  blocks: string[]; // text of each block (paragraph, heading, list item, ...) in the main content, for line-level diffing
  text: string; // all main content text: blocks joined with "\n"
  links: string[]; // outbound links in the main content (filtered + normalized; see links.ts)
  malformed: string[]; // hrefs that aren't valid URLs
  images: Image[]; // images in the main content, in page order
  // what boilerplate removal took out (menus, footers, sidebars, everything outside <main>, and blocks
  // Kohlschütter's classifier dropped), kept separately since boilerplate changes can matter too
  boilerplate: { blocks: string[]; links: string[]; images: Image[] };
}

// an <img>, identified by its URL + alt text (not its contents; see extractImages)
export interface Image {
  src: string; // absolute URL
  alt: string;
}

export interface ExtractOptions {
  // also run Kohlschütter's boilerplate classifier on the text (see kohlschutter.ts); off = tag rules only
  // off by default for now (didn't work too well on mit.edu)
  kohlschutter?: boolean;
}

// boilerplate removal happens in two steps:
//   1. tag rules (splitContent): drop nav/header/footer/etc. and anything outside <main>; applies to text, links + images
//   2. Kohlschütter's classifier: drop short, link-heavy text blocks; applies to TEXT ONLY.
//      it classifies the whole page (like the paper), but we only use its results inside the main content
//
// `pageUrl` is the page's real URL (for a snapshot: the original URL, not the web.archive.org one); links are resolved against it
export function extract(doc: Document, pageUrl: string, options: ExtractOptions = {}): PageContent {
  const { kohlschutter = false } = options;
  if (!doc.body) {
    return { url: pageUrl, title: doc.title.trim(), blocks: [], text: '', links: [], malformed: [], images: [], boilerplate: { blocks: [], links: [], images: [] } };
  }
  // copy so we don't modify the real page; script/style/hidden elements and Wayback's toolbar aren't content at all
  const page = doc.body.cloneNode(true) as Element;
  for (const el of page.querySelectorAll(`${NON_CONTENT}, ${WAYBACK_INJECTED}`)) el.remove();

  // step 2's classification runs BEFORE step 1 splits the page, so it sees the whole page like in the paper
  const classified = kohlschutter ? findBoilerplate(page) : [];
  const split = splitContent(page, doc);
  // (blocks outside main are already boilerplate from step 1)
  const removed = classified.filter((nodes) => split.main.contains(nodes[0]!));

  const base = baseUrl(doc, pageUrl);
  const { links, malformed } = extractLinks(split.main, pageUrl, base);
  const blocks = toBlocks(split.main, new Set(removed.flat()));
  const images = extractImages(split.main, base);
  const boilerplate = {
    blocks: [...toBlocks(split.boilerplate), ...removed.map(textOf)],
    links: extractLinks(split.boilerplate, pageUrl, base).links,
    images: extractImages(split.boilerplate, base),
  };

  return { url: pageUrl, title: doc.title.trim(), blocks, text: blocks.join('\n'), links, malformed, images, boilerplate };
}

// elements whose text isn't visible page content
const NON_CONTENT = 'script, style, noscript, template, [hidden]';

// site chrome (menus, banners, sidebars, footers), not the page's own content
const BOILERPLATE =
  'nav, header, footer, aside, [role="navigation"], [role="banner"], [role="contentinfo"], [role="complementary"]';

// toolbar + banners the Wayback Machine injects into snapshots (not present if we fetch the raw
// snapshot with the "id_" URL flag, e.g. web.archive.org/web/<timestamp>id_/<url>)
const WAYBACK_INJECTED = '#wm-ipp-base, #wm-ipp, #donato';

// split `page` (already a cleaned copy; modified in place) into
//   main: the page's own content, and
//   boilerplate: the site chrome removed from it (in page order, except boilerplate found inside <main> comes last)
// simple tag/role-based heuristic (step 1 above; Kohlschütter's classifier is step 2)
// TODO: benchmark none vs. tags vs. tags + Kohlschütter and see how each changes diff results
function splitContent(page: Element, doc: Document): { main: Element; boilerplate: Element } {
  // if the page marks its main content, use only that; everything else on the page is boilerplate
  const main = page.querySelector('main, [role="main"]');
  let root = page;
  let boilerplate: Element = doc.createElement('div');
  if (main) {
    main.remove();
    root = main;
    boilerplate = page;
  }

  for (const el of root.querySelectorAll(BOILERPLATE)) {
    // a <header>/<footer> inside an <article> is usually the article's own title/byline, not site chrome
    if (el.matches('header, footer') && el.parentElement?.closest('article')) continue;
    boilerplate.append(el); // moves it out of root
  }
  return { main: root, boilerplate };
}

// elements that start a new line of text when rendered
const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'br', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
  'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav',
  'ol', 'p', 'pre', 'section', 'summary', 'table', 'td', 'th', 'tr', 'ul',
]);

// split the text into blocks, one per paragraph/heading/list item/etc., whitespace collapsed, skipping
// text nodes in `skip` (e.g. ones Kohlschütter's classifier marked as boilerplate)
// (walks text nodes instead of using innerText: innerText needs layout, which Node (linkedom) doesn't have)
// TODO: <pre> whitespace gets collapsed too; could preserve it if we want?
function toBlocks(root: Element, skip: Set<Node> = new Set()): string[] {
  const blocks: string[] = [];
  let current = '';
  const flush = () => {
    const text = current.replace(/\s+/g, ' ').trim();
    if (text) blocks.push(text);
    current = '';
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) { // text node
      if (!skip.has(node)) current += node.textContent;
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

// every <img> with an http(s) src, resolved against `base`, in page order (duplicates kept, since order matters for diffing)
// skips data: URIs (usually tiny icons/placeholders, and can be huge strings) and srcs that aren't valid URLs.
// snapshots fetched with "id_" keep their original image URLs, so live and snapshot srcs can be compared directly
// TODO: maybe hash image contents to catch an image that changed but kept its URL? This could be an extra Wayback request, though...
function extractImages(root: Element, base: string): Image[] {
  const images: Image[] = [];
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src')!;
    if (!URL.canParse(src, base)) continue;
    const url = new URL(src, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    images.push({ src: url.href, alt: (img.getAttribute('alt') ?? '').replace(/\s+/g, ' ').trim() });
  }
  return images;
}

// the text of a list of text nodes, whitespace collapsed
function textOf(nodes: Node[]): string {
  return nodes.map((n) => n.textContent).join('').replace(/\s+/g, ' ').trim();
}

// the URL relative links are resolved against: the page's <base href> if it has one, else the page URL
function baseUrl(doc: Document, pageUrl: string): string {
  const href = doc.querySelector('base[href]')?.getAttribute('href');
  return href && URL.canParse(href, pageUrl) ? new URL(href, pageUrl).href : pageUrl;
}
