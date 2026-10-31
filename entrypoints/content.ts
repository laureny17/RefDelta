export default defineContentScript({
  matches: ['<all_urls>'],
  main() {
    // run on extension's "Analyze" button
    browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'analyze') {
        const result = collectLinks();
        console.log('[RefDelta]', result);
        sendResponse(result);
      }
    });
  },
});

// TODO: refine parsing and filtering logic as needed; currently skeleton w/ basic functionality
function collectLinks() {
  const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]');
  // (1) keep only http(s) links (drop mailto:, javascript:, etc.)
  // (2) drop links that point back to the same page (e.g. "#introduction")
  // (3) normalize (remove fragments and tracking params) + (4) dedupe
  // TODO: filter out nav/header/footer links? (part of boilerplate removal in content parser)
  // TODO: assess any other filtering criteria?
  const links = new Set<string>();
  const malformed = new Set<string>(); // hrefs that aren't valid URLs; kept so we can flag them as broken
  for (const a of anchors) {
    if (!URL.canParse(a.href)) {
      malformed.add(a.getAttribute('href')!);
      continue;
    }
    const url = new URL(a.href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue;
    if (isSamePage(url)) continue;
    links.add(normalize(url));
  }

  return { title: document.title, links: [...links], malformed: [...malformed] };
}

// helper: check if URL points to same page as the current page (i.e. we are ignoring fragments like "#introduction")
function isSamePage(url: URL): boolean {
  return (
    url.origin === location.origin &&
    url.pathname === location.pathname &&
    url.search === location.search
  );
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
