/**
 * ที่เก็บสมุดบัญชีการนับบนเครื่อง
 *
 * ## ทำไมคีย์ต้องมี userId
 *
 * เครื่อง PDA ใช้ร่วมกันหลายคนต่อกะ และ `/api/pda/session` คืน **รอบ active เดียวกัน
 * ให้ทุกคน** คีย์ที่มีแค่ `sessionId` จึงเป็นคีย์เดียวกันสำหรับพนักงานทุกคนบนเครื่องนั้น
 *
 * ลำดับที่เคยทำให้ข้อมูลปนกัน:
 *   1. A นับ 40 SKU แล้วส่งไม่สำเร็จ (เน็ตคลังกระตุก) — แถวค้างใน localStorage
 *   2. A ล็อกเอาต์ · signOut() เดิมล้างแต่ catalog ไม่ได้แตะสมุด
 *   3. B ล็อกอินเครื่องเดิม ได้ sessionId เดียวกัน → สมุดของ A ถูกกู้ขึ้นมาเป็นของ B
 *   4. B กดส่ง → server บันทึกด้วย countedBy = B
 *
 * ถ้า A ไปส่งจากอีกเครื่องด้วย จะกลายเป็นคนละแถวใน count_lines (คีย์ upsert คือ
 * sessionId + lineKey + countedBy) — **ของชิ้นเดียวถูกนับสองครั้ง** และผลต่างทั้งรอบเพี้ยน
 *
 * แยกออกมาจาก useLedger เพื่อให้เทสได้โดยไม่ต้อง render React — รับ Storage เข้ามา
 * ไม่อ้าง localStorage ตรง ๆ
 */
import type { LedgerRow } from '@cycle-count/core';

/**
 * v3 = เพิ่ม userId เข้าไปในคีย์
 * v2 = โครง LedgerRow เปลี่ยนเป็นหนึ่งแถวต่อ SKU (มี units ข้างใน)
 */
const PREFIX = 'cc:ledger:';
const VERSION = 'v3';

export function ledgerStorageKey(userId: string, sessionId: string): string {
  return `${PREFIX}${VERSION}:${userId}:${sessionId}`;
}

/** คีย์สมุดทั้งหมดที่อยู่ในเครื่อง ไม่ว่าเวอร์ชันไหน */
function ledgerKeys(storage: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}

export function loadLedger(storage: Storage, userId: string, sessionId: string): LedgerRow[] {
  try {
    const raw = storage.getItem(ledgerStorageKey(userId, sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LedgerRow[]) : [];
  } catch {
    // ข้อมูลค้างจากเวอร์ชันเก่าหรือ JSON พัง — เริ่มใหม่ดีกว่าจอขาว
    return [];
  }
}

export function saveLedger(
  storage: Storage,
  userId: string,
  sessionId: string,
  rows: LedgerRow[],
): void {
  try {
    storage.setItem(ledgerStorageKey(userId, sessionId), JSON.stringify(rows));
  } catch {
    // เต็ม/โดนปิด — ไม่ควรทำให้การนับสะดุด
  }
}

/**
 * ล้างสมุดทุกเล่มบนเครื่อง — เรียกตอนล็อกเอาต์
 *
 * ต้องล้าง**ของทุกคน** ไม่ใช่เฉพาะคนที่กำลังออก เพราะเครื่องนี้จะถูกส่งต่อให้คนถัดไป
 * และของที่ยังไม่ได้ส่งของคนก่อนหน้าไม่ควรค้างอยู่ให้กู้ขึ้นมาผิดตัว
 */
export function clearAllLedgers(storage: Storage): number {
  const keys = ledgerKeys(storage);
  for (const key of keys) storage.removeItem(key);
  return keys.length;
}

/**
 * ทิ้งสมุดจากคีย์รุ่นก่อน (v1/v2) ที่ไม่มี userId
 *
 * **ห้ามย้ายเข้ามาเป็นของผู้ใช้ปัจจุบัน** — ของพวกนั้นไม่รู้ว่าเป็นของใคร
 * การเดาว่าเป็นของคนที่เพิ่งล็อกอินคือการสร้างบั๊กเดิมขึ้นมาใหม่
 * ระบบยังไม่ขึ้นใช้จริง จึงไม่มีข้อมูลที่ต้องรักษา
 */
export function purgeLegacyLedgers(storage: Storage): number {
  const legacy = ledgerKeys(storage).filter((k) => !k.startsWith(`${PREFIX}${VERSION}:`));
  for (const key of legacy) storage.removeItem(key);
  return legacy.length;
}
