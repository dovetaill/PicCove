import type { UploadItem } from './upload-manager';

type StoredUpload = UploadItem & { owner: string };

function transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return new Promise((resolve, reject) => {
    let db: IDBDatabase | undefined;
    let tx: IDBTransaction | undefined;
    let settled = false;
    const finish = (error?: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      db?.close();
      if (error) reject(error); else resolve(result as T);
    };
    const timer = setTimeout(() => {
      try { tx?.abort(); } catch { /* The transaction may already be complete. */ }
      finish(new Error('本地上传记录保存超时'));
    }, 4000);
    try {
      const open = indexedDB.open('piccove-uploads', 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('uploads', { keyPath: ['owner', 'id'] }).createIndex('owner', 'owner');
      };
      open.onerror = () => finish(open.error);
      open.onblocked = () => finish(new Error('本地上传记录被其他页面占用'));
      open.onsuccess = () => {
        db = open.result;
        if (settled) { db.close(); return; }
        db.onversionchange = () => db?.close();
        try {
          tx = db.transaction('uploads', mode);
          const request = action(tx.objectStore('uploads'));
          tx.oncomplete = () => finish(undefined, request?.result);
          tx.onabort = () => finish(tx?.error || new Error('本地上传记录未能保存'));
          tx.onerror = () => finish(tx?.error || new Error('本地上传记录不可用'));
        } catch (error) { finish(error); }
      };
    } catch (error) { finish(error); }
  });
}

export function loadUploads(owner: string) {
  return transaction<StoredUpload[]>('readonly', (store) => store.index('owner').getAll(owner));
}
export function saveUpload(owner: string, item: UploadItem, create: boolean) {
  return transaction('readwrite', (store) => {
    if (create) { store.add({ ...item, owner }); return; }
    const current = store.get([owner, item.id]);
    // An update from another tab must not resurrect a cleared record.
    current.onsuccess = () => { if (current.result) store.put({ ...item, owner }); };
  });
}
export function deleteUploads(owner: string, ids: string[]) {
  return transaction('readwrite', (store) => { ids.forEach((id) => store.delete([owner, id])); });
}
