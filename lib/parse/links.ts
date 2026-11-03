// link extraction + filtering (moved here from content.ts so it works on any Document, e.g. a
// Wayback snapshot, not just the live page). URLs are resolved against `baseUrl` rather than the
// document's own URL, since a parsed snapshot's document URL isn't the page's real URL

// TODO: refine filtering logic as needed; currently skeleton w/ basic functionality
// TODO: assess any other filtering criteria?
export function extractLinks(
  root: ParentNode,
  pageUrl: string,
  baseUrl: string = pageUrl,
): { links: string[]; malformed: string[] } {
  const page = new URL(pageUrl);
  // (1) keep only http(s) links (drop mailto:, javascript:, etc.)
  // (2) drop links that point back to the same page (e.g. "#introduction")
  // (3) drop "share this page" links (e.g. twitter.com/share?url=<this page>)
  // (4) normalize (remove fragments and tracking params) + (5) dedupe
  const links = new Set<string>();
  const malformed = new Set<string>(); // hrefs that aren't valid URLs; kept so we can flag them as broken
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href')!;
    if (!URL.canParse(href, baseUrl)) {
      malformed.add(href);
      continue;
    }
    const url = new URL(href, baseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (isSamePage(url, page)) continue;
    if (isShareLink(url, page)) continue;
    links.add(normalize(url));
  }
  return { links: [...links], malformed: [...malformed] };
}

// helper: check if URL points to same page (i.e. we are ignoring fragments like "#introduction")
function isSamePage(url: URL, page: URL): boolean {
  return url.origin === page.origin && url.pathname === page.pathname && url.search === page.search;
}

// known "share this page" endpoints (host without "www.", path prefix)
// TODO: add more as we find them
const SHARE_ENDPOINTS = [
  { host: 'twitter.com', path: '/share' },
  { host: 'twitter.com', path: '/intent/' },
  { host: 'x.com', path: '/share' },
  { host: 'x.com', path: '/intent/' },
  { host: 'facebook.com', path: '/sharer' },
  { host: 'linkedin.com', path: '/shareArticle' },
  { host: 'linkedin.com', path: '/sharing/' },
  { host: 'reddit.com', path: '/submit' },
  { host: 'pinterest.com', path: '/pin/create' },
  { host: 'api.whatsapp.com', path: '/send' },
  { host: 't.me', path: '/share' },
];

// helper: check if URL is a "share this page" button rather than a reference, either
// (1) a known share endpoint, or
// (2) any link with a query param that points back to this page (e.g. ?url=<this page>, ?u=<this page>),
//     which catches share buttons for sites not in the list
function isShareLink(url: URL, page: URL): boolean {
  const host = withoutWww(url.hostname);
  if (SHARE_ENDPOINTS.some((e) => host === e.host && url.pathname.startsWith(e.path))) return true;

  // check if any param value points back to this page
  return [...url.searchParams.values()].some(
    (value) => URL.canParse(value) && isLooselySamePage(new URL(value), page),
  );
}

// helper for isShareLink
// like isSamePage, but ignores http vs https, "www.", trailing slashes, and the query string,
// since share links often embed a slightly different form of the page URL
function isLooselySamePage(url: URL, page: URL): boolean {
  const trimSlash = (path: string) => path.replace(/\/$/, '');
  return (
    withoutWww(url.hostname) === withoutWww(page.hostname) &&
    trimSlash(url.pathname) === trimSlash(page.pathname)
  );
}

function withoutWww(hostname: string): string {
  return hostname.replace(/^www\./, '');
}

// query params added by ad/analytics platforms that don't change page content
const TRACKING_PARAMS = ['fbclid', 'gclid']; // TODO: add more tracking params to exclude as needed

// strip the #fragment and tracking params so equivalent URLs compare equal
function normalize(url: URL): string {
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.startsWith('utm_') || TRACKING_PARAMS.includes(key)) {
      url.searchParams.delete(key);
    }
  }
  return url.href;
}
