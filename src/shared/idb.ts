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
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };

    request.onerror = () => {
      reject(request.error ?? new Error("IndexedDB open failed"));
    };
  });
}

async function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = openDatabase().catch((error) => {
      dbPromise = null;
      throw error;
    });
  }

  return dbPromise;
}

function transactionDone(transaction: IDBTransaction, errorMessage: string): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error(errorMessage));
    transaction.onabort = () => reject(transaction.error ?? new Error(errorMessage));
  });
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
  await transactionDone(tx, "Failed to store recording");
}

export async function putPart(part: RecordingPartRecord): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(PARTS_STORE, "readwrite");
  tx.objectStore(PARTS_STORE).put(part);
  await transactionDone(tx, "Failed to store part");
}

export async function getRecording(recordingId: string): Promise<RecordingRecord | undefined> {
  const db = await getDb();
  const tx = db.transaction(RECORDINGS_STORE, "readonly");
  const request = tx.objectStore(RECORDINGS_STORE).get(recordingId);
  return await requestToPromise<RecordingRecord | undefined>(request);
}

export async function getPartsByRecordingId(recordingId: string): Promise<RecordingPartRecord[]> {
  const db = await getDb();
  const tx = db.transaction(PARTS_STORE, "readonly");
  const index = tx.objectStore(PARTS_STORE).index("recordingId");
  const request = index.getAll(recordingId);
  const parts = await requestToPromise<RecordingPartRecord[]>(request);
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

  await transactionDone(tx, "Failed to delete recording");
}
