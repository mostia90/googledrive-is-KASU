// ============================================================
//  IndexedDB への保存
//   - project ストア : キューリストと設定（小さい JSON）
//   - blobs   ストア : 音声ファイルの実体
//  これにより、一度取り込めばネット接続なしで再生できます。
// ============================================================

const DB_NAME = "kasu-sound";
const DB_VERSION = 1;
let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("project")) db.createObjectStore("project");
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const store = {
  getProject: () => tx("project", "readonly", (s) => s.get("current")),
  setProject: (p) => tx("project", "readwrite", (s) => s.put(p, "current")),

  getBlob: (id) => tx("blobs", "readonly", (s) => s.get(id)),
  putBlob: (id, blob) => tx("blobs", "readwrite", (s) => s.put(blob, id)),
  deleteBlob: (id) => tx("blobs", "readwrite", (s) => s.delete(id)),
  allBlobKeys: () => tx("blobs", "readonly", (s) => s.getAllKeys()),

  async clearAll() {
    await tx("blobs", "readwrite", (s) => s.clear());
    await tx("project", "readwrite", (s) => s.clear());
  },

  async estimate() {
    if (!navigator.storage?.estimate) return null;
    try { return await navigator.storage.estimate(); } catch { return null; }
  },

  async persist() {
    if (!navigator.storage?.persist) return false;
    try { return await navigator.storage.persist(); } catch { return false; }
  },

  async isPersisted() {
    if (!navigator.storage?.persisted) return false;
    try { return await navigator.storage.persisted(); } catch { return false; }
  },
};
