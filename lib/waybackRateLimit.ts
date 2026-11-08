// all requests to the Wayback Machine go through waybackFetch(), which:
//   1. paces them, with a separate clock for each kind of request (see INTERVAL_MS), without waiting for earlier
//      responses (so several can be in flight), and
//   2. on a 429 ("too many requests"), stops ALL Wayback requests (both kinds) until a saved "blocked until" time
//      TODO: look into ways to get past this?? quite slow
//
// limits aren't officially published... best current source: the Python `wayback` library, whose defaults Internet
// Archive staff asked to be 80% of the hard limits: CDX (lookups) 30/min -> 24/min, mementos (snapshot downloads)
// 600/min -> 480/min
//   - source: https://github.com/edgi-govdata-archiving/wayback/blob/0a525a4acc232391d7329bd0a7ad828982218a31/src/wayback/_client.py#L66-L69
//   - the CDX default was lowered to 24/min in June 2026 "to match the actual hard limits now set on Wayback Machine servers"
//     (https://wayback.readthedocs.io/en/latest/release-history.html)
//   - Internet Archive guidance/developer best practice for automated access: https://archive.org/developers/bots.html
//   - September 2026 announcement: https://blog.archive.org/2026/09/15/an-update-on-wayback-machine-access/
// reportedly, continuing to send requests after a 429 can escalate to a ~1 hour IP block,
// so we should never retry automatically after a 429
//   - source: https://github.com/edgi-govdata-archiving/wayback/issues/137
//        - 2023, Internet Archive Slack support channel response: "If 429s are ignored for more than a minute we block the
//          IP at the firewall (no connection) for 1 hour, which is what happened to you. Subsequent 429s over a given period
//          will double that time each occurrence."

// the kinds of Wayback request, each paced on its own clock
export type WaybackRequestKind =
  | 'lookup' // CDX query: does a URL have snapshots, and when are they from
  | 'download'; // a snapshot's archived page

// minimum time between sends of each kind
// TODO: revisit pacing decision upon experimentation?
const INTERVAL_MS: Record<WaybackRequestKind, number> = {
  lookup: 60_000 / 24, // 24/min = 2.5s, the CDX limit above
  // 480/min is the memento limit above, minus our 24 lookups/min: the library notes "the memento limit is actually a
  // generic Wayback limit", so lookups may count toward it too; this keeps both kinds together under 480/min (~132ms)
  download: 60_000 / (480 - 24),
};

// how long to pause after a 429 if the server doesn't send a Retry-After header
const DEFAULT_PAUSE_MS = 10 * 60 * 1000; // 10 min

// give up on a request after this long; timeouts are reported as errors (not retried)
// TODO: look into this more to determine if 30s is appropriate + if we should do smth else on timeouts
const TIMEOUT_MS = 30 * 1000; // 30 s

// saved in storage.local (not session!!) so the pause survives a browser restart
const BLOCKED_UNTIL_KEY = 'waybackBlockedUntil';

export class WaybackRateLimitedError extends Error {
  constructor(public blockedUntil: number) {
    super(`Wayback rate limit hit; paused until ${new Date(blockedUntil).toLocaleTimeString()}`);
    this.name = 'WaybackRateLimitedError';
  }
}

// earliest time the next Wayback request of each kind may be sent
const nextSlotAt: Record<WaybackRequestKind, number> = { lookup: 0, download: 0 };

// NOTE: only call waybackFetch() from the background script; if the popup or content script also
// called it, each would get its own separate clocks and together they'd exceed the rate limit
// `onSent`: called once the request is sent, i.e. after waiting for its slot (e.g. to show progress)
export async function waybackFetch(
  url: string | URL,
  kind: WaybackRequestKind,
  onSent: () => void = () => {},
): Promise<Response> {
  await waitForSlot(kind);
  await throwIfPaused();
  let res: Response;
  try {
    const pending = fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    onSent(); // after starting the request, so whatever onSent does doesn't delay sending it
    res = await pending;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'TimeoutError') {
      throw new Error(`Wayback request timed out after ${TIMEOUT_MS / 1000}s`);
    }
    throw err; // e.g. network error
  }
  if (res.status === 429) throw await pauseForRateLimit(res);
  return res;
}

// wait until a request of this kind sent now wouldn't have to wait for a slot. doesn't reserve one: for callers that
// start many requests (e.g. L1 lookups), so they start one per slot instead of all at once. starting them all at once
// would still be paced, but would reserve slots far ahead, holding up other runs' requests and sending
// requests for runs that are already outdated
// re-checks after each sleep, since another request (e.g. another tab's lookup) may have taken the slot meanwhile
export async function waitForFreeSlot(kind: WaybackRequestKind) {
  while (nextSlotAt[kind] > Date.now()) await sleep(nextSlotAt[kind] - Date.now());
}

// wait for the next send slot of this kind: all Wayback requests of a kind (every caller, every tab) share one clock,
// so their sends are always at least INTERVAL_MS[kind] apart
async function waitForSlot(kind: WaybackRequestKind) {
  const slot = Math.max(Date.now(), nextSlotAt[kind]);
  nextSlotAt[kind] = slot + INTERVAL_MS[kind];
  await sleep(slot - Date.now());
}

// if we're still paused from an earlier 429, throw right away instead of sending the request
async function throwIfPaused() {
  const stored = await browser.storage.local.get(BLOCKED_UNTIL_KEY);
  const blockedUntil = stored[BLOCKED_UNTIL_KEY] as number | undefined;
  if (blockedUntil && Date.now() < blockedUntil) throw new WaybackRateLimitedError(blockedUntil);
}

// on a 429: save the "blocked until" time (so every later request, including after a browser
// restart, fails fast via throwIfPaused) and return the error to throw
async function pauseForRateLimit(res: Response): Promise<WaybackRateLimitedError> {
  const blockedUntil = Date.now() + retryAfterMs(res);
  await browser.storage.local.set({ [BLOCKED_UNTIL_KEY]: blockedUntil });
  return new WaybackRateLimitedError(blockedUntil);
}

// Retry-After is either a number of seconds or an HTTP date (i haven't seen one yet to know which - lauren)
function retryAfterMs(res: Response): number {
  const header = res.headers.get('Retry-After');
  if (!header) return DEFAULT_PAUSE_MS;
  const seconds = Number(header);
  const ms = Number.isNaN(seconds) ? Date.parse(header) - Date.now() : seconds * 1000;
  return Number.isNaN(ms) ? DEFAULT_PAUSE_MS : Math.max(ms, DEFAULT_PAUSE_MS);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
