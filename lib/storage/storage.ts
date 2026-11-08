import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ChangeLabel } from "../classify/classify-interface";


// the classifier's label, or "rotted" if the link is dead (decided before any diff runs, so it isn't a classifier label)
export type ChangeType = ChangeLabel | "rotted";

export interface CrawlRecord {
  id?: number;               
  url: string;
  status: number | null;        // HTTP code; null if the request failed (DNS, timeout)
  error_message?: string // if error
  session_id: string;
  parent_crawl_ts: number;      // ms since when the user clicked
  crawl_timestamp: number;      // ms since when this URL was fetched
  change_type: ChangeType;
  parent_url: string | null;    // null for the L0 page
  diff: unknown;            // TODO?     
}

interface RefDeltaDB extends DBSchema {
  crawls: {
    key: number;
    value: CrawlRecord;
    indexes: {
      by_url: string;
      by_session: string;
      by_parent: [string, number];        // [parent_url, parent_crawl_ts]
      by_url_time: [string, number];      // [url, crawl_timestamp]
    };
  };
}

const DB_NAME = "refdelta";
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<RefDeltaDB>> | null = null;

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<RefDeltaDB>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const store = db.createObjectStore("crawls", { keyPath: "id", autoIncrement: true });
        store.createIndex("by_url", "url");
        store.createIndex("by_session", "session_id");
        store.createIndex("by_parent", ["parent_url", "parent_crawl_ts"]);
        store.createIndex("by_url_time", ["url", "crawl_timestamp"]);
      },
    });
  }
  return dbPromise;
}

// insert one record + return id 
export async function saveCrawl(record: CrawlRecord): Promise<number> {
  const db = await getDB();
  return db.add("crawls", record);
}

// insert mult records 
export async function saveCrawls(records: CrawlRecord[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("crawls", "readwrite");
  await Promise.all([...records.map(r => tx.store.add(r)), tx.done]);
}

// get all links from parent
export async function getChildren(parentUrl: string, parentCrawlTs: number) {
  const db = await getDB();
  return db.getAllFromIndex("crawls", "by_parent", [parentUrl, parentCrawlTs]);
}

// fet most recent for url 
export async function getLatest(url: string): Promise<CrawlRecord | undefined> {
  const db = await getDB();
  const range = IDBKeyRange.bound([url, 0], [url, Infinity]);
  const cursor = await db.transaction("crawls").store
    .index("by_url_time").openCursor(range, "prev");  
  return cursor?.value;
}


export async function getSession(sessionId: string) {
  const db = await getDB();
  return db.getAllFromIndex("crawls", "by_session", sessionId);
}

// delete a session for cleanup
export async function clearSession(sessionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction("crawls", "readwrite");
  for await (const cursor of tx.store.index("by_session").iterate(sessionId)) {
    await cursor.delete();
  }
  await tx.done;
}