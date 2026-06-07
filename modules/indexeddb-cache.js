const DB_NAME = 'LocalAISubtitlesCache';
const DB_VERSION = 1;
const MODEL_STORE = 'model_weights';
const CONFIG_STORE = 'model_config';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(MODEL_STORE)) {
        database.createObjectStore(MODEL_STORE, { keyPath: 'key' });
      }
      if (!database.objectStoreNames.contains(CONFIG_STORE)) {
        database.createObjectStore(CONFIG_STORE, { keyPath: 'key' });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => {
      reject(new Error(`IndexedDB open failed: ${event.target.error}`));
    };
  });
}

export async function getModelItem(key) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MODEL_STORE, 'readonly');
    const store = tx.objectStore(MODEL_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ? request.result.data : null);
    request.onerror = () => reject(request.error);
  });
}

export async function setModelItem(key, data) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MODEL_STORE, 'readwrite');
    const store = tx.objectStore(MODEL_STORE);
    const request = store.put({ key, data });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function removeModelItem(key) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MODEL_STORE, 'readwrite');
    const store = tx.objectStore(MODEL_STORE);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function clearModelCache() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MODEL_STORE, 'readwrite');
    const store = tx.objectStore(MODEL_STORE);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getModelConfig(key) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(CONFIG_STORE, 'readonly');
    const store = tx.objectStore(CONFIG_STORE);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result ? request.result.data : null);
    request.onerror = () => reject(request.error);
  });
}

export async function setModelConfig(key, data) {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(CONFIG_STORE, 'readwrite');
    const store = tx.objectStore(CONFIG_STORE);
    const request = store.put({ key, data });
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export async function getCacheSize() {
  const database = await openDB();
  return new Promise((resolve, reject) => {
    const tx = database.transaction(MODEL_STORE, 'readonly');
    const store = tx.objectStore(MODEL_STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      let total = 0;
      for (const item of request.result) {
        if (item.data && item.data.byteLength) {
          total += item.data.byteLength;
        }
      }
      resolve(total);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getCacheStats() {
  const size = await getCacheSize();
  const config = await getModelConfig('whisper_meta');
  return {
    sizeBytes: size,
    sizeMB: (size / (1024 * 1024)).toFixed(1),
    modelType: config ? config.modelType : null,
    modelVersion: config ? config.version : null,
    cachedAt: config ? config.cachedAt : null,
  };
}
