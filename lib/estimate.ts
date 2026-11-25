// time estimates for checking L1 links, shared by the popup and the on-page block picker.
// each link takes one Wayback lookup, paced at 24/min (LOOKUP_INTERVAL_MS), which is the bottleneck

import { LOOKUP_INTERVAL_MS } from './waybackRateLimit';

// e.g. "12 links · ~30 s"
export function estimateText(links: number): string {
  if (links === 0) return 'no links';
  return `${links} link${links === 1 ? '' : 's'} · ~${roughDuration(links * LOOKUP_INTERVAL_MS)}`;
}

// "~40 s" under a minute (to the nearest 5 s), otherwise whole minutes rounded up ("~7 min")
export function roughDuration(ms: number): string {
  const s = ms / 1000;
  return s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s` : `${Math.ceil(s / 60)} min`;
}
