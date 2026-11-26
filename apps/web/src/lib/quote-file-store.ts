/**
 * The rate confirmation dropped on a quote, kept in this browser until the quote is booked: a saved quote cannot hold a document on the server (documents belong to loads, server/tl/documents.ts),
 * and a file cannot live in a typed-field draft. So the file and what the reading said about it (a TONU notice, a lumper, its warnings) wait here, under the quote's draft key, and are
 * uploaded to the load when it is booked. Another computer does not have them: booking there says to attach the file under Paperwork. Browser only; every call fails soft (private windows,
 * full or blocked storage), because the in-memory copy still covers the page as it is.
 */
export type KeptRateCon<M> = { file: File | null; meta: M };

const DB_NAME = "tl-quote-files";
const STORE = "files";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") return reject(new Error("no indexedDB"));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve) => {
      const req = op(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export const keepRateCon = <M>(key: string, kept: KeptRateCon<M>) => run<IDBValidKey>("readwrite", (s) => s.put(kept, key));
export const readRateCon = <M>(key: string) => run<KeptRateCon<M>>("readonly", (s) => s.get(key));
export const forgetRateCon = (key: string) => run<undefined>("readwrite", (s) => s.delete(key));
