// Saved songs: persistent on-device library of built practice tracks.
//
// Why IndexedDB and not a server database:
// - Render's free tier has no persistent disk, so data/songs/*.json is wiped
//   on every redeploy. Anything worth keeping must live somewhere else.
// - A hosted database costs money (Render's free Postgres expires after
//   90 days) and needs logins and migrations for what is really a personal
//   practice list.
// - A built song is just JSON (tens of KB for a 1-2 minute section).
//   IndexedDB holds megabytes per origin, survives redeploys, and works
//   with zero backend changes.
//
// Trade-off: the library lives on the device/browser it was built on.
// Laptop songs and phone songs are separate libraries.

import type { SongData } from "./types";

export interface SavedSongMeta {
  /** "local-" + the server songId, also used as the practice-page route id */
  id: string;
  title: string;
  youtubeUrl: string;
  /** epoch ms */
  createdAt: number;
  noteCount: number;
  /** seconds */
  duration: number;
}

interface SavedSongRecord extends SavedSongMeta {
  song: SongData;
}

const DB_NAME = "keysync";
const STORE = "songs";
const DB_VERSION = 1;
const LOCAL_PREFIX = "local-";

export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_PREFIX);
}

export function makeLocalId(songId: string): string {
  return `${LOCAL_PREFIX}${songId}`;
}

export function stripLocalId(localId: string): string {
  return localId.startsWith(LOCAL_PREFIX)
    ? localId.slice(LOCAL_PREFIX.length)
    : localId;
}

export function buildMeta(
  song: SongData,
  youtubeUrl: string,
  createdAt: number = Date.now()
): SavedSongMeta {
  return {
    id: makeLocalId(song.songId),
    title: song.title,
    youtubeUrl,
    createdAt,
    noteCount: song.melody.length,
    duration: song.duration,
  };
}

function dbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!dbAvailable()) {
      reject(new Error("IndexedDB is not available"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

function tx<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = run(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Persist a freshly built song. Returns the local id used for routing. */
export async function saveSong(
  song: SongData,
  youtubeUrl: string
): Promise<string> {
  const meta = buildMeta(song, youtubeUrl);
  const record: SavedSongRecord = { ...meta, song };
  const db = await openDb();
  try {
    await tx(db, "readwrite", (s) => s.put(record));
  } finally {
    db.close();
  }
  return meta.id;
}

/** Newest first. Returns [] when storage is unavailable. */
export async function listSavedSongs(): Promise<SavedSongMeta[]> {
  try {
    const db = await openDb();
    try {
      const records = await tx<SavedSongRecord[]>(db, "readonly", (s) =>
        s.getAll()
      );
      return records
        .map(
          (r): SavedSongMeta => ({
            id: r.id,
            title: r.title,
            youtubeUrl: r.youtubeUrl,
            createdAt: r.createdAt,
            noteCount: r.noteCount,
            duration: r.duration,
          })
        )
        .sort((a, b) => b.createdAt - a.createdAt);
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export async function getSavedSong(localId: string): Promise<SongData | null> {
  try {
    const db = await openDb();
    try {
      const record = await tx<SavedSongRecord | undefined>(db, "readonly", (s) =>
        s.get(localId)
      );
      return record?.song ?? null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

export async function deleteSavedSong(localId: string): Promise<void> {
  const db = await openDb();
  try {
    await tx(db, "readwrite", (s) => s.delete(localId));
  } finally {
    db.close();
  }
}
