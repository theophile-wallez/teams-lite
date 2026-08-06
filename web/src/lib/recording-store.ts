/**
 * Where a call recording is kept: this browser's own storage, and nowhere else.
 *
 * **There is no upstream, on purpose.** A recording is teams-lite's own file — Teams knows
 * nothing about it and must not (see `./call-recording.ts`) — and the backend is not asked to
 * hold it either: it would mean pushing a hundred megabytes of base64 across a WebSocket
 * built for JSON, and then serving it back to a `<video>` that needs to seek. So the bytes
 * stay where they were made, which is also the narrowest thing this app could do with a
 * recording of somebody's voice.
 *
 * That has one consequence the UI must state rather than hide, and it does: a recording made
 * on the phone is not on the laptop, and clearing the browser's data takes them with it. The
 * card offers to save the file out, which is how a recording becomes something the user
 * really keeps.
 *
 * IndexedDB and not `localStorage`: this is the only thing in the app measured in megabytes,
 * and `localStorage` holds strings inside a five-megabyte budget. Every function here is
 * best-effort and SSR-safe — no IndexedDB, a private window that refuses one, a quota that is
 * full: each degrades to "there are no recordings" or "this one was not kept", which the
 * caller reports. Never let a storage failure take a call down.
 */

import type { CallRecording } from "./call-recording";

const DB_NAME = "teams-lite";
const DB_VERSION = 1;
/** One store, keyed by the recording's own id, holding the metadata and the blob together:
 *  a row and its bytes are written in one transaction, so there is no state where the app
 *  knows about a recording whose file it cannot find. */
const STORE = "call-recordings";

/** A stored row: everything {@link CallRecording} carries, plus the file. */
type StoredRecording = CallRecording & { blob: Blob };

/** Whether this browser can keep a recording at all. Read before offering to record, so the
 *  control is honest on a machine where the file would be lost the moment it was made. */
export function recordingsCanBeKept(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    // A refusal is not an error worth propagating: a private window that blocks storage, or a
    // database an older build left in a shape this one cannot open, both mean "no recordings".
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

/** Run one transaction and close the connection behind it.
 *
 *  A connection per call rather than one held open for the session: an open connection blocks
 *  another tab's upgrade, and this store is touched a handful of times in a session. */
async function withStore<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest,
  fallback: T,
): Promise<T> {
  const db = await open();
  if (!db) return fallback;
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      db.close();
      resolve(value);
    };
    try {
      const transaction = db.transaction(STORE, mode);
      const request = work(transaction.objectStore(STORE));
      request.onsuccess = () => finish(request.result as T);
      request.onerror = () => finish(fallback);
      transaction.onabort = () => finish(fallback);
      transaction.onerror = () => finish(fallback);
    } catch {
      finish(fallback);
    }
  });
}

/**
 * Keep one recording, and say whether it was kept.
 *
 * `false` is the answer the caller has to act on: the file is in hand and could not be
 * stored, which is what a full quota looks like, and the user is told rather than shown a
 * card whose video is missing.
 */
export async function putRecording(recording: CallRecording, blob: Blob): Promise<boolean> {
  const row: StoredRecording = { ...recording, blob };
  const key = await withStore<IDBValidKey | null>("readwrite", (store) => store.put(row), null);
  return key !== null;
}

/**
 * Every recording this browser holds, newest first — the metadata alone.
 *
 * The blobs are deliberately left behind: the sidebar and the history draw a card per
 * recording, and reading a hundred megabytes of video to draw a row that says "4.2 MB" would
 * cost the open of every conversation.
 */
export async function listRecordings(): Promise<CallRecording[]> {
  const rows = await withStore<StoredRecording[]>("readonly", (store) => store.getAll(), []);
  return rows
    .map(({ blob: _blob, ...meta }) => meta)
    .sort((a, b) => b.endedAtMs - a.endedAtMs);
}

/** One recording's file, or null when this browser does not hold it. */
export async function getRecordingBlob(id: string): Promise<Blob | null> {
  const row = await withStore<StoredRecording | undefined>(
    "readonly",
    (store) => store.get(id),
    undefined,
  );
  return row?.blob ?? null;
}

/** Forget one, file and all. There is nothing upstream to take it back from — a deletion
 *  here is the whole deletion, which is why the card asks twice before it calls this. */
export async function deleteRecording(id: string): Promise<void> {
  await withStore<undefined>("readwrite", (store) => store.delete(id), undefined);
}
