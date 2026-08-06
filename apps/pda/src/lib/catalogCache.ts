/**
 * แคช catalog ของรอบนับลง IndexedDB
 *
 * ทำไมไม่ localStorage: index ของ 10,000 SKU ประมาณ 2 MB ซึ่งชน quota 5 MB
 * ของ localStorage ได้ง่าย และการ JSON.parse ก้อนใหญ่เป็น sync จะทำให้จอค้าง
 *
 * เก็บทั้งก้อนเป็นเรคอร์ดเดียว โหลดขึ้น Map ตอนเปิดแอป — ค้นบาร์โค้ดหลังจากนั้น
 * เป็น O(1) ในหน่วยความจำ ไม่แตะดิสก์และไม่แตะเน็ตอีกเลย
 */
import type { BarcodeLookup } from '@cycle-count/core';

export interface CatalogSnapshot {
  sessionId: string;
  generatedAt: string;
  /** version ที่ server ใช้ตรวจแบบ atomic ตอนส่งผลนับ */
  catalogVersion: string;
  /** ETag จาก server — ส่งกลับไปเป็น If-None-Match เพื่อขอแค่ 304 */
  etag: string | null;
  entries: BarcodeLookup[];
}

const DB_NAME = 'cycle-count';
const DB_VERSION = 1;
const STORE = 'catalog';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'sessionId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('เปิด IndexedDB ไม่ได้'));
  });
}

function tx<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB ทำงานผิดพลาด'));
      }),
  );
}

export async function readCatalog(sessionId: string): Promise<CatalogSnapshot | null> {
  try {
    const found = await tx<CatalogSnapshot | undefined>('readonly', (s) => s.get(sessionId));
    return found ?? null;
  } catch {
    // แคชอ่านไม่ได้ไม่ใช่เรื่องคอขาดบาดตาย — โหลดใหม่จาก server แทน
    return null;
  }
}

export async function writeCatalog(snapshot: CatalogSnapshot): Promise<void> {
  try {
    await tx('readwrite', (s) => s.put(snapshot));
  } catch {
    // เขียนไม่ได้ (โควตาเต็ม/โหมดส่วนตัว) ก็ยังนับต่อได้ แค่ต้องโหลดใหม่รอบหน้า
  }
}

/** ใช้ตอนแอดมินสั่ง "โหลด catalog ใหม่" หรือปิดรอบ */
export async function clearCatalog(sessionId: string): Promise<void> {
  try {
    await tx('readwrite', (s) => s.delete(sessionId));
  } catch {
    /* ไม่เป็นไร */
  }
}

/**
 * สร้าง Map บาร์โค้ด → รายการ สำหรับค้นตอนสแกน
 *
 * รอบ blind ฝั่ง server ตัดคีย์ `expectedBaseQty` ทิ้งทั้งอัน (ไม่ได้ส่งเป็น null)
 * เพื่อให้ตรวจการรั่วด้วยการ grep ชื่อ field ได้ — ที่นี่จึงต้องเติมกลับเป็น null
 * ไม่งั้น variance() ที่เช็ค `=== null` จะหลุดไปคำนวณกับ undefined แล้วได้ NaN
 */
export function indexEntries(entries: BarcodeLookup[]): Map<string, BarcodeLookup> {
  return new Map(
    entries.map((e) => [e.barcode, { ...e, expectedBaseQty: e.expectedBaseQty ?? null }]),
  );
}
