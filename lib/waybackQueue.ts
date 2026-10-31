// all requests to the Wayback Machine go through waybackFetch(), which:
//   1. runs them one at a time, at least MIN_INTERVAL_MS apart, and
//   2. on a 429 ("too many requests"), stops ALL Wayback requests until a saved "blocked until" time
//      TODO: look into ways to get past this?? quite slow
//
// limits aren't officially published... best current source: the Python `wayback` library
// (tuned with Internet Archive staff) lowered its CDX default to 24 requests/min in June 2026
// "to match the actual hard limits now set on Wayback Machine servers"
//   - source: https://wayback.readthedocs.io/en/latest/release-history.html
//   - Internet Archive guidance/developer best practice for automated access: https://archive.org/developers/bots.html
//   - September 2026 announcement: https://blog.archive.org/2026/09/15/an-update-on-wayback-machine-access/
// reportedly, continuing to send requests after a 429 can escalate to a ~1 hour IP block,
// so we should never retry automatically after a 429
//   - source: https://github.com/edgi-govdata-archiving/wayback/issues/137
//        - 2023, Internet Archive Slack support channel response: "If 429s are ignored for more than a minute we block the
//          IP at the firewall (no connection) for 1 hour, which is what happened to you. Subsequent 429s over a given period
//          will double that time each occurrence."

// 3s between requests = 20/min, a margin under the 24/min limit above to be safe
// TODO: revisit pacing decision upon experimentation?
const MIN_INTERVAL_MS = 3000;

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

let queue: Promise<unknown> = Promise.resolve(); // tail of the request chain
let lastRequestAt = 0;

// NOTE: only call waybackFetch() from the background script; if the popup or content script also
// called it, each would get its own separate queue and together they'd exceed the rate limit
export function waybackFetch(url: string | URL): Promise<Response> {
  const request = queue.then(async () => {
    await throwIfPaused();
    const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);

    lastRequestAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new Error(`Wayback request timed out after ${TIMEOUT_MS / 1000}s`);
      }
      throw err; // e.g. network error
    }
    if (res.status === 429) {
      const blockedUntil = Date.now() + retryAfterMs(res);
      await browser.storage.local.set({ [BLOCKED_UNTIL_KEY]: blockedUntil });
      throw new WaybackRateLimitedError(blockedUntil);
    }
    return res;
  });
  queue = request.catch(() => {}); // a failed request shouldn't break the chain for the next one
  return request;
}

// if we're still paused from an earlier 429, throw right away instead of sending the request
async function throwIfPaused() {
  const stored = await browser.storage.local.get(BLOCKED_UNTIL_KEY);
  const blockedUntil = stored[BLOCKED_UNTIL_KEY] as number | undefined;
  if (blockedUntil && Date.now() < blockedUntil) throw new WaybackRateLimitedError(blockedUntil);
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
