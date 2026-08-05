/**
 * สถานะสมุดบัญชีของหน้าจอนับสต็อก
 *
 * เก็บลง localStorage แบบหน่วงเวลา แล้ว flush ทันทีเมื่อแอปกำลังจะหายไปจากหน้าจอ —
 * PDA ในคลังโดน WebView รีโหลดหรือแบตหมดกลางรอบได้เสมอ ของที่นับไปแล้วต้องไม่หาย
 * (ดู SAVE_DEBOUNCE_MS ว่าทำไมถึงไม่เขียนทุกครั้งที่ state เปลี่ยน)
 *
 * การค้นบาร์โค้ดเป็น sync เพราะ catalog ถูกโหลดลงเครื่องไว้ก่อนแล้ว (ดู lib/api.ts)
 * ไม่มีสถานะ "กำลังค้น" ให้ผู้ใช้ต้องรอ
 *
 * SKU ที่ส่งสำเร็จไปแล้วในรอบนี้จะถูกล็อก สแกนซ้ำไม่ขึ้นเป็นแถวใหม่ (ดู submittedLog.ts)
 * กันกับดักทยอยส่ง: ถ้าไม่ล็อก ส่ง 5 กล่องไปแล้วเดินต่อเจออีก 3 แล้วสแกนใหม่ จะส่งทับ
 * เหลือ 3 แทนที่จะเป็น 8 เพราะสมุดถูกล้างว่างหลังส่งสำเร็จทุกครั้ง
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyScan,
  applyUnknownScan,
  bumpUnitQty as bumpUnitQtyPure,
  countedBaseQty,
  ledgerKey,
  ledgerTotals,
  removeRow as removeRowPure,
  removeUnit as removeUnitPure,
  setUnitQty as setUnitQtyPure,
  toCountLines,
  type LedgerRow,
  type SubmitVariance,
} from '@cycle-count/core';

import { api, lookup } from './api';
import { loadLocked, saveLocked, type LockedEntry } from './submittedLog';

export type ScanState =
  | { kind: 'idle' }
  /** อ้างแถวด้วย key ไม่ใช่ snapshot ของแถว — แก้จำนวนแล้วข้อความจะได้ตามทัน */
  | { kind: 'found'; barcode: string; key: string; uom: string }
  | { kind: 'unknown'; barcode: string }
  /** SKU นี้เคยถูกส่งไปแล้วในรอบนี้จากเครื่องนี้ — ห้ามสแกนซ้ำ (ดู submittedLog.ts) */
  | { kind: 'locked'; barcode: string; key: string; entry: LockedEntry };

export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  /** ส่งสำเร็จ — variance คือใบเฉลยที่ server คำนวณให้หลังบันทึกแล้ว */
  | { kind: 'done'; saved: number; variance: SubmitVariance }
  | { kind: 'error'; message: string };

/**
 * v2 = โครง LedgerRow เปลี่ยนเป็นหนึ่งแถวต่อ SKU (มี units ข้างใน)
 * ขึ้นเวอร์ชันเพื่อไม่ให้เครื่องที่มีข้อมูลค้างจากโครงเก่าอ่านแล้วพัง
 */
const storageKey = (sessionId: string) => `cc:ledger:v2:${sessionId}`;

/**
 * หน่วงการเขียนลงเครื่องเท่านี้ก่อนเขียนจริง
 *
 * 800 ms สั้นกว่าจังหวะที่คนหยิบของชิ้นถัดไปมายิง แต่ยาวพอจะกลืนการกดคีย์แพดรัว ๆ
 * ให้เหลือการเขียนครั้งเดียว — ยิงติดกัน 20 ครั้งใน 15 วินาทีเขียนราว 18 ครั้งลดเหลือ ~1
 */
const SAVE_DEBOUNCE_MS = 800;

function load(sessionId: string): LedgerRow[] {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LedgerRow[]) : [];
  } catch {
    // ข้อมูลค้างจากเวอร์ชันเก่าหรือ JSON พัง — เริ่มใหม่ดีกว่าจอขาว
    return [];
  }
}

function save(sessionId: string, rows: LedgerRow[]) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(rows));
  } catch {
    // เต็ม/โดนปิด — ไม่ควรทำให้การนับสะดุด
  }
}

/**
 * สั่นสั้น = รับแล้ว, สั่นสั้นสองจังหวะ = ไม่รู้จัก, สั่นยาวครั้งเดียว = ถูกล็อก (ห้ามส่งซ้ำ)
 * แยกรูปแบบให้ต่างกันชัดเจนเพราะคนนับมักไม่ได้มองจอตอนสแกน
 */
function buzz(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
  }
}

const LOCKED_BUZZ = 220;

export function useLedger(sessionId: string | null) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [scanState, setScanState] = useState<ScanState>({ kind: 'idle' });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });
  const [restored, setRestored] = useState(false);

  /**
   * SKU ที่ส่งสำเร็จไปแล้วในรอบนี้จากเครื่องนี้ — append-only ต่อรอบนับ (ดู submittedLog.ts)
   * เป็น ref ไม่ใช่ state เพราะแค่ต้องอ่านตอนสแกน ไม่ต้องทำให้จอ re-render เมื่อมันเปลี่ยน
   */
  const locked = useRef<Map<string, LockedEntry>>(new Map());

  useEffect(() => {
    if (!sessionId) return;
    setRows(load(sessionId));
    locked.current = loadLocked(sessionId);
    setRestored(true);
  }, [sessionId]);

  /*
   * เขียนลงเครื่องแบบหน่วงเวลา แต่ยัง flush ทันทีตอนแอปกำลังจะหายไปจากหน้าจอ
   *
   * เดิมเขียนทุกครั้งที่ rows เปลี่ยน = ทุกการยิงบาร์โค้ด **และทุกปุ่มคีย์แพดตอนแก้จำนวน**
   * แต่ละครั้งคือ JSON.stringify ทั้งสมุด (300 SKU ราว 100 KB) แล้วเขียนแบบ sync บน UI thread
   * ยิงรัว ๆ ในคลังจึงเสียทั้งความลื่นและแบตไปกับการเขียน flash ซ้ำ ๆ ที่ไม่มีใครอ่าน
   *
   * เหตุผลที่ยังต้อง flush: ฟังก์ชันนี้มีไว้กัน WebView รีโหลด/แบตหมดกลางรอบแล้วของที่นับหาย
   * ถ้าหน่วงเฉย ๆ โดยไม่ flush ก็เท่ากับทำลายเหตุผลเดียวที่มันมีอยู่
   * flush ตอน hidden/pagehide ทำให้หน้าต่างเสี่ยงเหลือแค่ <1 วินาทีของการสแกนต่อเนื่องจริง ๆ
   */
  const pending = useRef<{ sessionId: string; rows: LedgerRow[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** ทิ้งงานเขียนที่ค้างอยู่โดยไม่เขียน — ใช้ตอนกำลังจะเขียนค่าที่ใหม่กว่าทับอยู่แล้ว */
  const cancelPendingSave = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    pending.current = null;
  }, []);

  const flush = useCallback(() => {
    const due = pending.current;
    cancelPendingSave();
    if (due) save(due.sessionId, due.rows);
  }, [cancelPendingSave]);

  /*
   * ตั้งใจไม่มี cleanup ที่ clearTimeout
   *
   * ถ้าใส่ cleanup ที่ล้าง timer ทิ้ง การเขียนตอน unmount จะไปพึ่ง "ลำดับของ effect"
   * ว่า cleanup ของ effect ที่ flush ต้องทำงานทีหลัง — วันไหนมีคนสลับลำดับ effect
   * ข้อมูลจะหายเงียบ ๆ โดยไม่มีอะไรฟ้อง
   *
   * แบบนี้ปลอดภัยทุกทางแทน: รอบถัดไปล้าง timer เก่าเองอยู่แล้ว (บรรทัดล่าง)
   * และถ้า timer หลุดมายิงหลัง unmount ก็แค่เขียนค่าที่ถูกต้องลงเครื่อง ไม่มี setState ให้พัง
   */
  useEffect(() => {
    if (!sessionId || !restored) return;

    pending.current = { sessionId, rows };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [sessionId, restored, rows, flush]);

  /*
   * แยก effect ออกมาเพราะ listener ต้องผูกครั้งเดียว ไม่ใช่ถอด/ใส่ใหม่ทุกครั้งที่ rows เปลี่ยน
   * flush อ่านค่าล่าสุดจาก ref อยู่แล้วจึงไม่ต้องมี rows เป็น dependency
   *
   * บน Capacitor การกดปุ่ม Home หรือจอดับทำให้ WebView ยิง visibilitychange เป็น hidden
   * ส่วน pagehide ครอบกรณีที่ WebView ถูกทำลายทิ้งโดยไม่ผ่าน hidden
   */
  useEffect(() => {
    function onHide() {
      if (document.visibilityState === 'hidden') flush();
    }
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);

    // unmount = ออกจากระบบหรือปิดรอบ ต้องเขียนของที่ค้างลงให้หมดก่อน
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const scan = useCallback((barcode: string) => {
    const code = barcode.trim();
    if (!code) return;

    setSubmitState({ kind: 'idle' });

    const hit = lookup(code);
    const key = ledgerKey(hit?.sku ?? null, hit?.barcode ?? code);

    /*
     * เช็คก่อนตัดสินใจว่าเจอหรือไม่เจอ — SKU ที่ส่งไปแล้วต้องถูกกันไม่ให้เข้าสมุดอีกเลย
     * ไม่ว่าจะยังหาใน master เจอหรือไม่ก็ตาม (ดูเหตุผลที่ submittedLog.ts)
     */
    const already = locked.current.get(key);
    if (already) {
      buzz(LOCKED_BUZZ);
      setScanState({ kind: 'locked', barcode: code, key, entry: already });
      return;
    }

    if (!hit) {
      buzz([90, 70, 90]);
      setRows((prev) => applyUnknownScan(prev, code));
      setScanState({ kind: 'unknown', barcode: code });
      return;
    }

    buzz(35);
    setRows((prev) => applyScan(prev, hit));
    setScanState({ kind: 'found', barcode: code, key, uom: hit.uom });
  }, []);

  const setUnitQty = useCallback((key: string, uom: string, qty: number) => {
    setRows((prev) => setUnitQtyPure(prev, key, uom, qty));
  }, []);

  const bumpUnitQty = useCallback((key: string, uom: string, delta: number) => {
    setRows((prev) => bumpUnitQtyPure(prev, key, uom, delta));
  }, []);

  const removeUnit = useCallback((key: string, uom: string) => {
    setRows((prev) => removeUnitPure(prev, key, uom));
    setScanState({ kind: 'idle' });
  }, []);

  const removeRow = useCallback((key: string) => {
    setRows((prev) => removeRowPure(prev, key));
    setScanState({ kind: 'idle' });
  }, []);

  const submit = useCallback(async () => {
    if (!sessionId || rows.length === 0) return;

    setSubmitState({ kind: 'sending' });
    try {
      const result = await api.submit({ sessionId, lines: toCountLines(rows) });

      /*
       * ล็อกทุกแถวที่เพิ่งส่งสำเร็จ กันสแกนซ้ำแล้วส่งทับยอดเดิมทีหลัง (ดู submittedLog.ts)
       * ต้องทำก่อน setRows([]) — ตัวแปร rows ในโคลชัวร์นี้ยังเป็นชุดที่เพิ่งส่งอยู่
       * ส่วน state ที่ React เห็นจะว่างไปแล้วหลังบรรทัดถัดไป ไม่กระทบการอ่านตรงนี้
       */
      const submittedAt = new Date().toISOString();
      const nextLocked = new Map(locked.current);
      for (const row of rows) {
        nextLocked.set(row.key, {
          sku: row.sku,
          name: row.name,
          baseQty: countedBaseQty(row),
          baseUom: row.baseUom,
          submittedAt,
        });
      }
      locked.current = nextLocked;
      saveLocked(sessionId, nextLocked);

      setRows([]);

      /*
       * เขียนสมุดว่างลงเครื่องทันที ไม่รอ debounce
       *
       * ถ้าแอปตายในช่วง 800 ms หลังส่งสำเร็จ แล้วยังเหลือของเก่าค้างอยู่บนดิสก์
       * พนักงานจะเปิดมาเจอรายการที่ส่งไปแล้วโผล่มาใหม่ แล้วนึกว่ายังไม่ได้ส่ง
       * (ส่งซ้ำไม่ทำให้ยอดเพี้ยนเพราะ server upsert แต่สร้างความสับสนโดยไม่จำเป็น)
       *
       * เขียนตรงแทนการเรียก flush() เพราะ pending ยังถือ rows ชุดเก่าอยู่ —
       * effect ที่อัปเดต pending ทำงานหลัง render ไม่ทันบรรทัดนี้
       */
      cancelPendingSave();
      save(sessionId, []);

      setScanState({ kind: 'idle' });
      setSubmitState({ kind: 'done', saved: result.saved, variance: result.variance });
    } catch (err) {
      setSubmitState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'ส่งผลไม่สำเร็จ ลองใหม่อีกครั้ง',
      });
    }
  }, [sessionId, rows, cancelPendingSave]);

  const dismissSubmit = useCallback(() => setSubmitState({ kind: 'idle' }), []);

  return {
    rows,
    totals: ledgerTotals(rows),
    scanState,
    submitState,
    scan,
    setUnitQty,
    bumpUnitQty,
    removeUnit,
    removeRow,
    submit,
    dismissSubmit,
  };
}
