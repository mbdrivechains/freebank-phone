// IndexedDB storage for the one pairing this phone holds. The device key P is a
// non-extractable CryptoKey, stored as-is (CryptoKey is structured-cloneable), so the page
// can use it but no script can read its bytes.

export interface Pairing {
  v: 1;
  relay: string; // wss://…/ws
  room: string;
  d: string; // b64u D_pub
  pPub: string; // b64u P_pub
  pPriv: CryptoKey; // non-extractable ECDH private key
  name: string; // device name shown on the desktop
  pairedAt: number; // ms since epoch
}

const DB = 'freebank-phone';
const STORE = 'kv';
const KEY = 'pairing';

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

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const r = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('aborted'));
    });
  } finally {
    db.close();
  }
}

export async function loadPairing(): Promise<Pairing | null> {
  const p = (await tx<Pairing>('readonly', (s) => s.get(KEY))) ?? null;
  return p && p.v === 1 && p.pPriv ? p : null;
}

export async function savePairing(p: Pairing): Promise<void> {
  await tx('readwrite', (s) => s.put(p, KEY));
}

/** "Forget this desktop": deletes the device key and the desktop's details. */
export async function forgetPairing(): Promise<void> {
  await tx('readwrite', (s) => s.delete(KEY));
}
