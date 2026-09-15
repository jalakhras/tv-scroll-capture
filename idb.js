const DB = 'tv-scroll-capture';
const STORE = 'results';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putResult(value) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, 'last');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getResult() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE).objectStore(STORE).get('last');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
