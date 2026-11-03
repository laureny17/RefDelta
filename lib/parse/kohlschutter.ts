// boilerplate detection from Kohlschütter et al. 2010, "Boilerplate Detection using Shallow Text Features"
// split the page into small text blocks, then classify each one as content or boilerplate from its word count
// and link density, plus those of the blocks before and after it.
// works on any page, including ones without semantic tags (e.g. older, all-<div> sites).
// cheap: one pass over the DOM + counting words
//
// differences from the paper:
//   - inline tags (<b>, <span>, ...) don't split blocks (see INLINE_TAGS)
//   - headings are never dropped (see findBoilerplate)
//   - the paper doesn't say what neighbor to use before the first / after the last block; we use 0 words, 0 links
//   - blocks with no words (e.g. just "|" or "©") are skipped

// a "word": whitespace-delimited, containing at least one letter or digit (paper 3.3).
// a "token" is any whitespace-delimited sequence (incl. non-words like "|"); link density is counted in tokens (3.3)
const WORD = /[\p{L}\p{N}]/u;

// inline formatting tags that DON'T split a block. the paper splits at every tag except <a> (4.1), but taken
// literally that turns "a <b>bold</b> word" into 3 one-word blocks, which the rules below would all call boilerplate.
const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'mark',
  'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var',
]);

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

interface TextBlock {
  nodes: Node[]; // the text nodes making up this block
  numWords: number;
  linkDensity: number; // fraction of tokens inside an <a>
  isHeading: boolean;
}

// returns the blocks Kohlschütter's classifier marks as boilerplate, each as the list of its text nodes
export function findBoilerplate(root: Element): Node[][] {
  const textBlocks = segment(root);
  const removed: Node[][] = [];
  const none = { numWords: 0, linkDensity: 0 }; // stand-in neighbor for the first/last block
  textBlocks.forEach((curr, i) => {
    // our addition (not in the paper): never drop headings; the paper's tree drops most short ones,
    // but a changed heading is a change we want to see
    if (curr.isHeading) return;
    if (isContent(textBlocks[i - 1] ?? none, curr, textBlocks[i + 1] ?? none)) return;
    removed.push(curr.nodes);
  });
  return removed;
}

// Algorithm 2 ("Classifier based on Number of Words", p. 444), same thresholds;
// the "C4.8 NumWords + LinkDensity, simplified" row in Table 2
type Features = { numWords: number; linkDensity: number };
function isContent(prev: Features, curr: Features, next: Features): boolean {
  if (curr.linkDensity > 0.333333) return false;
  if (prev.linkDensity <= 0.555556) {
    if (curr.numWords <= 16) {
      if (next.numWords <= 15) return prev.numWords > 4;
      return true;
    }
    return true;
  }
  if (curr.numWords <= 40) return next.numWords > 17;
  return true;
}

// split into blocks of text, breaking at every non-inline tag; blocks with no words are skipped
function segment(root: Element): TextBlock[] {
  const blocks: TextBlock[] = [];
  let nodes: Node[] = [];
  let numWords = 0;
  let numTokens = 0;
  let linkedTokens = 0;
  const flush = () => {
    if (numWords > 0) {
      const isHeading = !!nodes[0]!.parentElement?.closest(HEADINGS);
      blocks.push({ nodes, numWords, linkDensity: linkedTokens / numTokens, isHeading });
    }
    nodes = [];
    numWords = 0;
    numTokens = 0;
    linkedTokens = 0;
  };
  const walk = (node: Node, inLink: boolean) => {
    if (node.nodeType === 3) { // text node
      const tokens = (node.textContent ?? '').split(/\s+/).filter(Boolean);
      nodes.push(node);
      numWords += tokens.filter((t) => WORD.test(t)).length;
      numTokens += tokens.length;
      if (inLink) linkedTokens += tokens.length;
      return;
    }
    if (node.nodeType !== 1) return; // skip comments etc.; 1 = element
    const tag = (node as Element).tagName.toLowerCase();
    const splits = !INLINE_TAGS.has(tag);
    if (splits) flush();
    for (const child of node.childNodes) walk(child, inLink || tag === 'a');
    if (splits) flush();
  };
  walk(root, false);
  flush();
  return blocks;
}
