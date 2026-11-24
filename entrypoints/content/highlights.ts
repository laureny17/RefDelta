// L1 link highlights, drawn in an overlay layer on top of the page (the page's own elements aren't changed or moved):
// every <a> whose URL is an L1 link gets a translucent highlighter-style tint over its text, colored on a red -> green
// spectrum by how similar the linked page is to its snapshot (link rot: red; no snapshot / failed: gray;
// pending: dashed outline). hovering the link shows the details. styles: overlay.css

import type { Analysis } from '@/lib/analysis';
import { normalize } from '@/lib/parse/links';

// how a link is highlighted; `kind` picks the style for results without a score (see overlay.css)
interface LinkResult {
  kind: 'pending' | 'scored' | 'rot' | 'skipped' | 'failed' | 'stopped';
  color?: string; // for 'scored': the tint, from the similarity (see spectrumColor)
  title: string; // first line of the hover details
  details: string[]; // more lines of hover details
}

// one highlighted <a> (a link that appears several times on the page has one per <a>)
interface Highlight {
  anchor: HTMLAnchorElement;
  url: string; // the L1 link it points to
  marks: HTMLElement[]; // one tint rectangle per line the link's text spans
  result?: LinkResult;
}

// scores bunch up near 1 (the placeholder thresholds are 0.8 / 0.99), so the spectrum is stretched at the top:
// hue = green * similarity^EXPONENT. with 4: 0.99 -> green, 0.95 -> yellow-green, 0.8 -> orange, 0.5 -> red
const SPECTRUM_EXPONENT = 4;
const GREEN_HUE = 130;

export class LinkHighlights {
  private layer?: HTMLElement; // holds every mark + the tooltip; removed by clear()
  private tooltip?: HTMLElement;
  private highlights: Highlight[] = [];
  private attached = false;
  private framePending = false;
  private resizeObserver?: ResizeObserver;
  private listeners: [HTMLAnchorElement, string, EventListener][] = []; // to remove on clear()

  // called with every saved analysis (see AnalysisUpdateMessage in lib/analysis.ts)
  update(analysis: Analysis) {
    // every run's first save has no live page yet; a new run starts fresh (the user may have re-run)
    if (!analysis.livePage) return this.clear();
    if (!this.attached) this.attach(analysis.livePage.links);
    for (const highlight of this.highlights) highlight.result = linkResult(highlight.url, analysis);
    this.scheduleReposition();
  }

  // remove the overlay (e.g. before re-reading the page, and when a new run starts)
  clear() {
    this.layer?.remove();
    this.layer = this.tooltip = undefined;
    for (const [anchor, type, listener] of this.listeners) anchor.removeEventListener(type, listener);
    this.listeners = [];
    this.highlights = [];
    this.attached = false;
    window.removeEventListener('resize', this.scheduleReposition);
    window.removeEventListener('scroll', this.scheduleReposition, true);
    this.resizeObserver?.disconnect();
  }

  // find each L1 link's <a> elements (matched by normalized URL, like lib/parse/links.ts does).
  // a link that's also in boilerplate (e.g. a nav menu) gets highlighted there too: same page, same result
  private attach(l1Links: string[]) {
    this.attached = true;
    const wanted = new Set(l1Links);
    // outside <body>, so the page's layout isn't affected and the page parser (which reads <body>) never sees it
    this.layer = document.createElement('refdelta-overlay');
    this.tooltip = document.createElement('refdelta-tooltip');
    this.tooltip.hidden = true; // shown while a highlighted link is hovered
    this.layer.append(this.tooltip);
    document.documentElement.append(this.layer);

    for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      if (!URL.canParse(anchor.href)) continue;
      const url = normalize(new URL(anchor.href)); // anchor.href is already resolved (incl. <base href>)
      if (!wanted.has(url)) continue;
      const highlight: Highlight = { anchor, url, marks: [] };
      this.highlights.push(highlight);
      // listeners only (the <a> itself isn't changed), so the link still works as usual
      this.listen(anchor, 'mouseenter', () => this.showDetails(highlight));
      this.listen(anchor, 'mouseleave', () => this.hideDetails());
    }

    // keep marks on their links as the page scrolls (incl. inner scrolling areas), resizes, or re-lays out
    window.addEventListener('resize', this.scheduleReposition);
    window.addEventListener('scroll', this.scheduleReposition, { capture: true, passive: true });
    this.resizeObserver = new ResizeObserver(this.scheduleReposition);
    this.resizeObserver.observe(document.body);
  }

  private listen(anchor: HTMLAnchorElement, type: string, listener: EventListener) {
    anchor.addEventListener(type, listener);
    this.listeners.push([anchor, type, listener]);
  }

  // reposition at most once per frame
  private scheduleReposition = () => {
    if (this.framePending) return;
    this.framePending = true;
    requestAnimationFrame(() => {
      this.framePending = false;
      this.reposition();
    });
  };

  // one mark over each line box of each link (in page coordinates, since the layer is absolutely positioned at the
  // top-left of the page); a link that isn't rendered (e.g. inside a collapsed menu) gets none
  private reposition() {
    if (!this.layer) return;
    for (const highlight of this.highlights) {
      const rects = [...highlight.anchor.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
      while (highlight.marks.length < rects.length) {
        const mark = document.createElement('refdelta-mark');
        this.layer.insertBefore(mark, this.tooltip!); // tooltip stays on top
        highlight.marks.push(mark);
      }
      for (const mark of highlight.marks.splice(rects.length)) mark.remove();
      highlight.marks.forEach((mark, i) => {
        const rect = rects[i]!;
        place(mark, rect.left + window.scrollX, rect.top + window.scrollY);
        mark.style.setProperty('width', `${rect.width}px`, 'important');
        mark.style.setProperty('height', `${rect.height}px`, 'important');
        mark.dataset.kind = highlight.result?.kind ?? 'pending';
        if (highlight.result?.color) mark.style.setProperty('background-color', highlight.result.color, 'important');
        else mark.style.removeProperty('background-color');
      });
    }
  }

  private showDetails({ anchor, url, result }: Highlight) {
    if (!this.tooltip || !result) return;
    const title = document.createElement('refdelta-tooltip-title');
    title.textContent = result.title;
    const lines = [...result.details, url].map((text) => {
      const line = document.createElement('refdelta-tooltip-line');
      line.textContent = text;
      return line;
    });
    this.tooltip.replaceChildren(title, ...lines);
    this.tooltip.hidden = false;
    // below the link's first line, kept inside the window horizontally
    const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth - this.tooltip.offsetWidth - 8);
    place(this.tooltip, Math.max(8, left) + window.scrollX, rect.bottom + window.scrollY + 6);
  }

  private hideDetails() {
    if (this.tooltip) this.tooltip.hidden = true;
  }
}

function place(el: HTMLElement, left: number, top: number) {
  el.style.setProperty('left', `${left}px`, 'important');
  el.style.setProperty('top', `${top}px`, 'important');
}

// similarity (0-1) -> a translucent tint from red (0) through yellow to green (1); see SPECTRUM_EXPONENT
function spectrumColor(similarity: number): string {
  const hue = GREEN_HUE * Math.max(0, Math.min(1, similarity)) ** SPECTRUM_EXPONENT;
  return `hsla(${hue.toFixed(0)}, 85%, 50%, 0.35)`;
}

// a link's highlight: its result if it has one, otherwise pending (or stopped, if lookups stopped before it finished)
function linkResult(link: string, analysis: Analysis): LinkResult {
  const lookup = analysis.linkLookups?.[link];
  const diff = analysis.linkDiffs?.[link];
  const stopped = analysis.linkLookupsStopped ?? (analysis.runState === 'stopped' ? 'stopped by user' : undefined);
  const snapshot = lookup && 'snapshot' in lookup ? lookup.snapshot : undefined;
  const snapshotLine = snapshot ? [`snapshot from ${snapshot.timestamp.slice(0, 4)}-${snapshot.timestamp.slice(4, 6)}-${snapshot.timestamp.slice(6, 8)}`] : [];

  if (lookup && 'error' in lookup) return { kind: 'failed', title: 'Check failed', details: [`snapshot lookup failed: ${lookup.error}`] };
  if (!diff) {
    if (stopped) return { kind: 'stopped', title: 'Not checked', details: [stopped] };
    return { kind: 'pending', title: 'Checking…', details: snapshotLine };
  }
  if ('error' in diff) return { kind: 'failed', title: 'Check failed', details: [diff.error] };
  if ('rot' in diff) return { kind: 'rot', title: 'Link rot', details: [diff.rot] };
  if ('skipped' in diff) {
    return { kind: 'skipped', title: snapshot === null ? 'No snapshot' : 'Not compared', details: [diff.skipped, ...snapshotLine] };
  }
  // the selected L1 differ's result (a benchmark config can run several; fall back to the first)
  const metric = diff.metrics.find((m) => m.algorithm === analysis.l1Algorithm) ?? diff.metrics[0];
  if (!metric) return { kind: 'failed', title: 'Check failed', details: ['no differ ran'] };
  if ('error' in metric) return { kind: 'failed', title: 'Check failed', details: [`${metric.algorithm}: ${metric.error}`] };
  return {
    kind: 'scored',
    color: spectrumColor(metric.similarity),
    title: `${(metric.similarity * 100).toFixed(1)}% similar · ${metric.label}`,
    details: [...snapshotLine, `compared with ${metric.algorithm}`],
  };
}
