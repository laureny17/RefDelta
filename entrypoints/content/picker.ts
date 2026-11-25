// "Select" scope: the user picks blocks of the page (paragraphs, lists, sections, ...) to analyze.
// hovering outlines the block under the cursor (↑/↓ grow it to the surrounding block or shrink it back), clicking
// adds/removes it, and a bar at the bottom shows the selection's link count + estimated time with Analyze / Cancel.
// drawn in its own overlay layer outside <body>, like the link highlights (styles: overlay.css)

import { estimateText } from '@/lib/estimate';
import { extract } from '@/lib/parse/extract';
import { linksInScope } from './scope';

export class BlockPicker {
  // the blocks picked for the latest confirmed selection; read when the run starts (see 'analyze' in index.ts)
  selection: Element[] = [];

  private picking = false;
  private links: string[] = []; // the page's L1 links, parsed when picking starts (for the bar's count)
  private hovered?: Element;
  private shrinkStack: Element[] = []; // blocks ↑ grew from, so ↓ can go back
  private onConfirm?: () => void;

  private layer?: HTMLElement;
  private hoverBox?: HTMLElement;
  private selectedBoxes = new Map<Element, HTMLElement>();
  private bar?: HTMLElement;
  private summary?: HTMLElement;
  private analyzeButton?: HTMLElement;
  private framePending = false;

  // start picking; `onConfirm` runs when the user clicks Analyze (with `selection` set)
  start(onConfirm: () => void) {
    this.stop();
    this.picking = true;
    this.onConfirm = onConfirm;
    this.selection = [];
    this.links = extract(document, location.href).links;

    this.layer = document.createElement('refdelta-overlay');
    this.hoverBox = document.createElement('refdelta-pick-box');
    this.hoverBox.dataset.state = 'hover';
    this.hoverBox.hidden = true;
    this.bar = this.buildBar();
    this.layer.append(this.hoverBox, this.bar);
    document.documentElement.append(this.layer);
    this.renderSummary();

    // capture phase, so the page doesn't react first (e.g. a link click navigating away)
    document.addEventListener('mousemove', this.onMouseMove, true);
    document.addEventListener('mousedown', this.onMouseDown, true);
    document.addEventListener('click', this.onClick, true);
    document.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('scroll', this.scheduleReposition, { capture: true, passive: true });
    window.addEventListener('resize', this.scheduleReposition);
  }

  // stop picking and remove the picker's UI (`selection` is kept for the run that's about to start)
  stop() {
    if (!this.picking) return;
    this.picking = false;
    this.layer?.remove();
    this.layer = this.hoverBox = this.bar = this.summary = this.analyzeButton = undefined;
    this.selectedBoxes.clear();
    this.hovered = undefined;
    this.shrinkStack = [];
    document.removeEventListener('mousemove', this.onMouseMove, true);
    document.removeEventListener('mousedown', this.onMouseDown, true);
    document.removeEventListener('click', this.onClick, true);
    document.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('scroll', this.scheduleReposition, true);
    window.removeEventListener('resize', this.scheduleReposition);
  }

  private buildBar(): HTMLElement {
    const bar = document.createElement('refdelta-pick-bar');
    this.summary = document.createElement('refdelta-pick-summary');
    const hint = document.createElement('refdelta-pick-hint');
    hint.textContent = 'click or Enter to select · ↑↓ grow/shrink · Esc to cancel';
    const text = document.createElement('refdelta-pick-text');
    text.append(this.summary, hint);

    this.analyzeButton = button('Analyze', 'primary', () => this.confirm());
    const cancel = button('Cancel', 'secondary', () => this.stop());
    bar.append(text, this.analyzeButton, cancel);
    return bar;
  }

  private confirm() {
    if (!this.selection.length) return;
    const onConfirm = this.onConfirm;
    this.stop();
    onConfirm?.();
  }

  // e.g. "3 blocks · 18 links · ~45 s"
  private renderSummary() {
    if (!this.summary || !this.analyzeButton) return;
    const count = this.selection.length;
    if (!count) {
      this.summary.textContent = 'No blocks selected';
      this.analyzeButton.dataset.disabled = '';
      return;
    }
    const links = linksInScope(this.links, 'select', this.selection).length;
    this.summary.textContent = `${count} block${count === 1 ? '' : 's'} · ${estimateText(links)}`;
    delete this.analyzeButton.dataset.disabled;
  }

  private onMouseMove = (event: MouseEvent) => {
    if (this.isInBar(event.target)) return this.setHovered(undefined);
    const block = blockAt(event.target as Element);
    if (block === this.hoveredBase()) return; // still over the same block (↑/↓ may have grown/shrunk it)
    this.shrinkStack = [];
    this.setHovered(block);
  };

  // the page doesn't get mousedowns while picking either (no focusing links, no text selection by dragging)
  private onMouseDown = (event: MouseEvent) => {
    if (this.isInBar(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  private onClick = (event: MouseEvent) => {
    if (this.isInBar(event.target)) return; // the bar's own buttons
    event.preventDefault();
    event.stopPropagation();
    if (this.hovered) this.toggle(this.hovered);
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (this.isInBar(event.target)) return; // e.g. Enter on a focused Analyze / Cancel button presses it
    if (event.key === 'Enter' && this.hovered) {
      event.preventDefault();
      this.toggle(this.hovered); // same as clicking the outlined block (incl. after growing it with ↑)
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.stop();
    } else if (event.key === 'ArrowUp' && this.hovered) {
      event.preventDefault(); // not scrolling the page
      const parent = blockAt(this.hovered.parentElement);
      if (parent) {
        this.shrinkStack.push(this.hovered);
        this.setHovered(parent);
      }
    } else if (event.key === 'ArrowDown' && this.shrinkStack.length) {
      event.preventDefault();
      this.setHovered(this.shrinkStack.pop());
    }
  };

  // the block the mouse is actually over (before any ↑ growing)
  private hoveredBase(): Element | undefined {
    return this.shrinkStack[0] ?? this.hovered;
  }

  private setHovered(block: Element | undefined) {
    this.hovered = block;
    this.repositionHover();
  }

  // add or remove a block. picking a block that contains selected ones replaces them; a block inside one that's
  // already selected is already included, so nothing changes
  private toggle(block: Element) {
    if (this.selection.includes(block)) {
      this.selection = this.selection.filter((b) => b !== block);
    } else if (!this.selection.some((b) => b.contains(block))) {
      this.selection = [...this.selection.filter((b) => !block.contains(b)), block];
    }
    this.syncSelectedBoxes();
    this.renderSummary();
  }

  private syncSelectedBoxes() {
    for (const [block, box] of this.selectedBoxes) {
      if (!this.selection.includes(block)) {
        box.remove();
        this.selectedBoxes.delete(block);
      }
    }
    for (const block of this.selection) {
      if (this.selectedBoxes.has(block)) continue;
      const box = document.createElement('refdelta-pick-box');
      box.dataset.state = 'selected';
      this.layer!.insertBefore(box, this.hoverBox!);
      this.selectedBoxes.set(block, box);
    }
    this.reposition();
  }

  private isInBar(target: EventTarget | null): boolean {
    return target instanceof Node && !!this.bar?.contains(target);
  }

  private scheduleReposition = () => {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this.reposition();
    });
  };

  private reposition() {
    for (const [block, box] of this.selectedBoxes) cover(box, block);
    this.repositionHover();
  }

  private repositionHover() {
    if (!this.hoverBox) return;
    this.hoverBox.hidden = !this.hovered;
    if (this.hovered) cover(this.hoverBox, this.hovered);
  }
}

// the nearest block-level element at or above `el` (a paragraph, list item, section, ...), skipping inline
// elements like links and <span>s; never <body>/<html> or our own overlay
function blockAt(el: Element | null): Element | undefined {
  for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
    if (e.tagName.startsWith('REFDELTA-')) return undefined;
    const display = getComputedStyle(e).display;
    if (display !== 'none' && display !== 'contents' && !display.startsWith('inline')) return e;
  }
  return undefined;
}

// position `box` over `el` (in page coordinates; the overlay layer sits at the page's top-left)
function cover(box: HTMLElement, el: Element) {
  const rect = el.getBoundingClientRect();
  const set = (prop: string, px: number) => box.style.setProperty(prop, `${px}px`, 'important');
  set('left', rect.left + window.scrollX);
  set('top', rect.top + window.scrollY);
  set('width', rect.width);
  set('height', rect.height);
}

function button(label: string, variant: 'primary' | 'secondary', onClick: () => void): HTMLElement {
  const el = document.createElement('refdelta-button');
  el.textContent = label;
  el.dataset.variant = variant;
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.addEventListener('click', onClick);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  });
  return el;
}
