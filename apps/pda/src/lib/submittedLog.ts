/**
 * บันทึกรายการที่ "ส่งสำเร็จ" ไปแล้วในรอบนับนี้ บนเครื่องนี้
 *
 * มีไว้ปิดกับดักทยอยส่งซ้ำ: เดิมถ้าส่ง SKU หนึ่งไป 5 กล่องแล้ว เดินต่อเจอเพิ่มอีก 3 กล่อง
 * แล้วสแกนใหม่ ยอดที่ส่งรอบสองจะ **เขียนทับ** ไม่ใช่บวกเพิ่ม เพราะสมุดในเครื่องถูกล้างว่าง
 * หลังส่งสำเร็จทุกครั้ง (ดูเหตุผลที่ useLedger.ts) แล้วรอบสองเริ่มนับจาก 0 ใหม่
 *
 * ทางแก้ที่เลือก: ปิดกั้นตั้งแต่จุดสแกน ไม่ให้เกิดการส่งซ้ำได้เลย แทนที่จะเปลี่ยนฝั่ง server
 * ให้บวกแทนเขียนทับ ซึ่งจะเสีย retry-safety เดิม (ส่งก้อนเดิมซ้ำเพราะเน็ตกระตุกยังปลอดภัย
 * เพราะ server upsert ทับด้วยค่าเดิมอยู่ดี) — ปิดกั้นที่จุดสแกนจึงไม่กระทบพฤติกรรม retry เลย
 *
 * เป็น append-only ต่อรอบนับ: คีย์หนึ่งถูกล็อกแล้วจะไม่ถูกปลดเองในแอป
 * ต้องแก้ยอดที่ส่งไปแล้วจริง ๆ ผ่านแอดมินเท่านั้น (หน้าเว็บยังไม่มีปุ่มนี้)
 */
export interface LockedEntry {
  sku: string | null;
  name: string;
  baseQty: number;
  baseUom: string;
  submittedAt: string;
}

const storageKey = (sessionId: string) => `cc:submitted:v1:${sessionId}`;

export function loadLocked(sessionId: string): Map<string, LockedEntry> {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return new Map();
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return new Map();
    return new Map(Object.entries(parsed as Record<string, LockedEntry>));
  } catch {
    // ข้อมูลค้างจากเวอร์ชันเก่าหรือ JSON พัง — เริ่มใหม่ดีกว่าจอขาว (เหมือน ledger)
    return new Map();
  }
}

export function saveLocked(sessionId: string, locked: ReadonlyMap<string, LockedEntry>): void {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(Object.fromEntries(locked)));
  } catch {
    // เต็ม/โดนปิด — ไม่ควรทำให้การส่งสะดุด ผลคือกันสแกนซ้ำไม่ได้แค่รอบนี้ ไม่ใช่ข้อมูลหาย
  }
}
