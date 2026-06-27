import type { RecordingPartRecord, RecordingRecord } from "./types.js";

const DB_NAME = "cropClip";
const DB_VERSION = 2;
const RECORDINGS_STORE = "recordings";
const PARTS_STORE = "parts";

let dbPromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(RECORDINGS_STORE)) {
        db.createObjectStore(RECORDINGS_STORE, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(PARTS_STORE)) {
        const store = db.createObjectStore(PARTS_STORE, { keyPath: "id" });
        store.createIndex("recordingId", "recordingId", { unique: false });
        store.createIndex("index", "index", { unique: false });
      }

    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
}

async function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase();
  }

  return dbPromise;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

export async function putRecording(recording: RecordingRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(RECORDINGS_STORE, "readwrite");
  tx.objectStore(RECORDINGS_STORE).put(recording);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to store recording"));
    tx.onabort = () => reject(tx.error ?? new Error("Failed to store recording"));
  });
}

export async function putPart(part: RecordingPartRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(PARTS_STORE, "readwrite");
  tx.objectStore(PARTS_STORE).put(part);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to store part"));
    tx.onabort = () => reject(tx.error ?? new Error("Failed to store part"));
  });
}

export async function getRecording(recordingId: string): Promise<RecordingRecord | undefined> {
  const db = await getDb();
  const tx = db.transaction(RECORDINGS_STORE, "readonly");
  const request = tx.objectStore(RECORDINGS_STORE).get(recordingId);
  const result = await requestToPromise<RecordingRecord | undefined>(request);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  return result;
}

export async function getPartsByRecordingId(recordingId: string): Promise<RecordingPartRecord[]> {
  const db = await getDb();
  const tx = db.transaction(PARTS_STORE, "readonly");
  const index = tx.objectStore(PARTS_STORE).index("recordingId");
  const request = index.getAll(recordingId);
  const parts = await requestToPromise<RecordingPartRecord[]>(request);
  await new Promise<void>((resolve) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  return parts.sort((left, right) => left.index - right.index);
}

export async function deleteRecording(recordingId: string): Promise<void> {
  const db = await getDb();
  const tx = db.transaction([RECORDINGS_STORE, PARTS_STORE], "readwrite");
  tx.objectStore(RECORDINGS_STORE).delete(recordingId);

  const partStore = tx.objectStore(PARTS_STORE);
  const index = partStore.index("recordingId");
  const keys = await requestToPromise<IDBValidKey[]>(index.getAllKeys(recordingId));
  for (const key of keys) {
    partStore.delete(key);
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Failed to delete recording"));
    tx.onabort = () => reject(tx.error ?? new Error("Failed to delete recording"));
  });
}
