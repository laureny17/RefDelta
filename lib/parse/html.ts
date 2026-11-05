// turn an HTML string into a Document that extract() can read.
// uses linkedom (a small JS HTML parser) instead of the browser's DOMParser, because DOMParser doesn't exist in
// the background service worker or in Node. using the same parser everywhere also means the benchmark (Node)
// parses pages exactly like the extension does

import { parseHTML } from 'linkedom';

export function parseHtml(html: string): Document {
  return parseHTML(html).document as unknown as Document;
}
