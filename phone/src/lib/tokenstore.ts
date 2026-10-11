// IndexedDB for the token wallet: its own database, apart from the pairing's. The seed is kept as bytes; the words
// are never stored.
import type { Keep } from './tokens';

const DB = 'freebank-tokens';
const STORE = 'kv';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB, 1);
    } catch (e) {
      reject(e);
      return;
    }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB unavailable'));
    req.onblocked = () => reject(new Error('IndexedDB blocked'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode, { durability: 'strict' });
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('aborted'));
    });
  } finally {
    db.close();
  }
}

export const tokenKeep: Keep = {
  get: <T>(key: string) => run<T>('readonly', (s) => s.get(key) as IDBRequest<T>),
  put: async (entries) => {
    await run('readwrite', (s) => {
      for (const [k, v] of Object.entries(entries)) s.put(v, k);
    });
  },
};
