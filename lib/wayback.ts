// Wayback Machine snapshot lookup via the CDX API.
// docs: https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server

import { waybackFetch } from './waybackRateLimit';

export interface Snapshot {
  timestamp: string; // "YYYYMMDDhhmmss", as returned by CDX
  statusCode: string; // HTTP status the archiver got, e.g. "200", "301", "404" ("-" for some records)
  snapshotUrl: string; // viewable archived page
}

// returns the snapshot of `url` closest to `timestamp`, or the most recent one when no
// timestamp is supplied. `timestamp` uses Wayback's "YYYYMMDDhhmmss" format.
// TODO: how to handle non-200 archive captures?
//  - fall back to the latest 200 for content comparison (filter=statuscode:200)?
//  - flag 404s?
// the raw archived HTML of a snapshot: the "id_" flag returns the page as originally captured,
// without the Wayback toolbar or Wayback's rewritten links
// `onSent`: called once the request is sent (after waiting for a rate-limit slot; see waybackFetch)
export async function fetchSnapshotHtml(snapshot: Snapshot, onSent?: () => void): Promise<string> {
  const rawUrl = snapshot.snapshotUrl.replace(`/web/${snapshot.timestamp}/`, `/web/${snapshot.timestamp}id_/`);
  const res = await waybackFetch(rawUrl, 'download', onSent); // paced (faster than lookups) + pauses on 429; see waybackRateLimit.ts
  if (!res.ok) throw new Error(`snapshot fetch failed: ${res.status}`);
  return res.text();
}

export async function findSnapshot(url: string, targetTimestamp?: string): Promise<Snapshot | null> {
  const query = new URL('https://web.archive.org/cdx/search/cdx');
  query.searchParams.set('url', url);
  query.searchParams.set('output', 'json');
  if (targetTimestamp) {
    query.searchParams.set('closest', targetTimestamp);
    query.searchParams.set('sort', 'closest');
    query.searchParams.set('limit', '1');
  } else {
    query.searchParams.set('limit', '-1'); // negative limit = last N results, i.e. -1 = most recent
  }
  query.searchParams.set('fl', 'timestamp,original,statuscode'); // fields to return in the response

  const res = await waybackFetch(query, 'lookup'); // paced + pauses on 429; see waybackRateLimit.ts
  if (!res.ok) throw new Error(`CDX request failed: ${res.status}`);

  const rows: string[][] = await res.json();
  if (rows.length < 2) return null; // empty response, i.e. no capture

  const [timestamp, original, statusCode] = rows[1] as [string, string, string];
  return { timestamp, statusCode, snapshotUrl: `https://web.archive.org/web/${timestamp}/${original}` };
}
