import { defineConfig } from 'wxt';

// See https://wxt.dev/api/reference/wxt/interfaces/inlineconfig.html
export default defineConfig({
  manifest: {
    // allow the extension to query the Wayback Machine's CDX API
    host_permissions: ['https://web.archive.org/*'],
    // TEMPORARY: storage.session holds per-tab analysis results
    // TODO: replace/complement with IndexedDB
    permissions: ['storage'],
  },
});
