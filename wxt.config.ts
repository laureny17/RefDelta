import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: {
    // fetch from any site: the Wayback Machine (CDX API + snapshots) and each L1 link's live page (see lib/linkDiff.ts)
    host_permissions: ['<all_urls>'],
    // TEMPORARY: storage.session holds per-tab analysis results
    // TODO: replace/complement with IndexedDB
    permissions: ['storage'],
  },
});
