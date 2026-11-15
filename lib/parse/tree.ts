import type { TreeNode, TreeRep } from '../diff/diff-interfaces';
import { cleanPage, splitContent } from './extract';
import { parseHtml } from './html';

export function htmlToTree(html: string): TreeRep {
  const doc = parseHtml(html);
  const root: TreeNode = { tag: '#root', path: '', children: [] };
  const page = cleanPage(doc);
  if (!page) return { kind: 'tree', root };
  const { main } = splitContent(page, doc);
  const stack: { source: Node; target: TreeNode }[] = [];
  const append = (source: Node, parent: TreeNode) => {
    const path = `${parent.path}/${parent.children.length}`;
    if (source.nodeType === 3) {
      const text = (source.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text) parent.children.push({ tag: '#text', text, path, children: [] });
    } else if (source.nodeType === 1) {
      const el = source as Element;
      const id = el.getAttribute('id');
      const target: TreeNode = {
        tag: el.tagName.toLowerCase(), path, children: [],
        ...(id ? { attrs: { id } } : {}),
      };
      parent.children.push(target);
      stack.push({ source, target });
    }
  };
  // The selected main/body container is represented by the artificial root.
  for (const child of main.childNodes) append(child, root);
  while (stack.length) {
    const { source, target } = stack.pop()!;
    for (const child of source.childNodes) append(child, target);
  }
  return { kind: 'tree', root };
}
