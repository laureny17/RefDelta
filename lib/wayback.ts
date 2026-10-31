// Wayback Machine snapshot lookup via the CDX API.
// docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server

import { waybackFetch } from './waybackQueue';

export interface Snapshot {
  timestamp: string; // "YYYYMMDDhhmmss", as returned by CDX
  statusCode: string; // HTTP status the archiver got, e.g. "200", "301", "404" ("-" for some records)
  snapshotUrl: string; // viewable archived page
}

// returns the most recent snapshot of `url`, or null if the Wayback Machine has none
// TODO: support "closest to a user-specified date" (CDX `closest` param)
// TODO: how to handle non-200 archive captures?
//  - fall back to the latest 200 for content comparison (filter=statuscode:200)?
//  - flag 404s?
export async function findLatestSnapshot(url: string): Promise<Snapshot | null> {
  const query = new URL('https://web.archive.org/cdx/search/cdx');
  query.searchParams.set('url', url);
  query.searchParams.set('output', 'json');
  query.searchParams.set('limit', '-1'); // negative limit = last N results, i.e. -1 = most recent
  query.searchParams.set('fl', 'timestamp,original,statuscode'); // fields to return in the response

  const res = await waybackFetch(query); // paced + pauses on 429; see waybackQueue.ts
  if (!res.ok) throw new Error(`CDX request failed: ${res.status}`);

  const rows: string[][] = await res.json();
  if (rows.length < 2) return null; // empty response, i.e. no capture

  const [timestamp, original, statusCode] = rows[1] as [string, string, string];
  return { timestamp, statusCode, snapshotUrl: `https://web.archive.org/web/${timestamp}/${original}` };
}
