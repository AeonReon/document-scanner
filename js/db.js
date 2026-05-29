// IndexedDB library wrapper. One store: 'scans'.
// Page images stored as JPEG Blobs. Thumbs as JPEG Blobs.
window.DS = window.DS || {};

(() => {
  const DB_NAME = 'docscanner';
  const DB_VER = 1;
  const STORE = 'scans';

  let _dbPromise = null;
  function open() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE, { keyPath: 'id' });
          s.createIndex('updatedAt', 'updatedAt');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode = 'readonly') {
    return open().then(db => db.transaction(STORE, mode).objectStore(STORE));
  }

  async function listAll() {
    const s = await tx();
    return new Promise((resolve, reject) => {
      const out = [];
      const req = s.index('updatedAt').openCursor(null, 'prev');
      req.onsuccess = (e) => {
        const c = e.target.result;
        if (c) { out.push(c.value); c.continue(); }
        else resolve(out);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function get(id) {
    const s = await tx();
    return new Promise((resolve, reject) => {
      const r = s.get(id);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function save(record) {
    const s = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const r = s.put(record);
      r.onsuccess = () => resolve(record);
      r.onerror = () => reject(r.error);
    });
  }

  async function remove(id) {
    const s = await tx('readwrite');
    return new Promise((resolve, reject) => {
      const r = s.delete(id);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }

  async function count() {
    const s = await tx();
    return new Promise((resolve, reject) => {
      const r = s.count();
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  DS.db = { listAll, get, save, remove, count };
})();
