// turn an HTML string into a Document that extract() can read.
// uses linkedom (a small JS HTML parser) instead of the browser's DOMParser, because DOMParser doesn't exist in
// the background service worker or in Node. using the same parser everywhere also means the benchmark (Node)
// parses pages exactly like the extension does

import { parseHTML } from 'linkedom';
import { extract } from './extract';

export function parseHtml(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}

// the text blocks (paragraphs, headings, list items, ...) of a page's main content, from its HTML string.
// for differs that compare text (tree-based ones would use parseHtml directly)
export function htmlToBlocks(html: string): string[] {
  return extract(parseHtml(html), 'about:blank').blocks; // placeholder URL: it's only used to resolve links, which aren't used here
}
