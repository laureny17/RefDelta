// developer-only switches

// show performance metrics (timings, diff sizes, parser output, ...) in the popup and the overlay.
// ON while we're building the extension; set to false for release, and every metrics UI disappears
// (UI code wrapped in `if (SHOW_DEV_METRICS)` is dropped from the build when this is false).
// metrics are still collected either way (the benchmark reads them from storage); this only controls showing them
export const SHOW_DEV_METRICS = true;
