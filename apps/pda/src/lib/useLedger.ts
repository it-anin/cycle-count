/**
 * สถานะสมุดบัญชีของหน้าจอนับสต็อก
 *
 * เก็บลง localStorage ทุกครั้งที่เปลี่ยน — PDA ในคลังโดน WebView รีโหลด
 * หรือแบตหมดกลางรอบได้เสมอ ของที่นับไปแล้วต้องไม่หาย
 *
 * การค้นบาร์โค้ดเป็น sync เพราะ catalog ถูกโหลดลงเครื่องไว้ก่อนแล้ว (ดู lib/api.ts)
 * ไม่มีสถานะ "กำลังค้น" ให้ผู้ใช้ต้องรอ
 */
import { useCallback, useEffect, useState } from 'react';

import {
  applyScan,
  applyUnknownScan,
  bumpUnitQty as bumpUnitQtyPure,
  ledgerKey,
  ledgerTotals,
  removeRow as removeRowPure,
  removeUnit as removeUnitPure,
  setUnitQty as setUnitQtyPure,
  toCountLines,
  type LedgerRow,
} from '@cycle-count/core';

import { api, lookup } from './api';
import { loadLedger, purgeLegacyLedgers, saveLedger } from './ledgerStorage';

export type ScanState =
  | { kind: 'idle' }
  /** อ้างแถวด้วย key ไม่ใช่ snapshot ของแถว — แก้จำนวนแล้วข้อความจะได้ตามทัน */
  | { kind: 'found'; barcode: string; key: string; uom: string }
  | { kind: 'unknown'; barcode: string };

export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; saved: number }
  | { kind: 'error'; message: string };

/** สั่นสั้น = รับแล้ว, สั่นยาวสองจังหวะ = ไม่รู้จัก (ใช้ตอนไม่ได้มองจอ) */
function buzz(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
  }
}

/**
 * สมุดบัญชีของ **ผู้ใช้คนหนึ่ง ในรอบนับหนึ่ง**
 *
 * ต้องรับ userId ด้วย ไม่ใช่แค่ sessionId — เครื่อง PDA ใช้ร่วมกันหลายคน
 * และทุกคนได้ sessionId เดียวกันจาก /api/pda/session (ดูเหตุผลเต็มใน ledgerStorage.ts)
 */
export function useLedger(userId: string | null, sessionId: string | null) {
  /**
   * เก็บ rows คู่กับคีย์ที่มันเป็นของ **ใน state ก้อนเดียวกัน**
   *
   * ถ้าแยกกัน จังหวะที่ผู้ใช้เปลี่ยน (สลับคนบนเครื่องเดิม) effect ที่ save จะทำงาน
   * ในคอมมิตเดียวกับ effect ที่ load โดยยังถือ rows ของคนเก่าอยู่ แล้วเขียนทับ
   * ลงคีย์ของคนใหม่ — คือบั๊กเดิมที่เรากำลังแก้ กลับมาทางประตูหลัง
   *
   * ผูกไว้ด้วยกันแล้วเงื่อนไข `loaded.key === key` จะกันจังหวะนั้นได้เอง
   */
  const key = userId && sessionId ? `${userId}:${sessionId}` : null;
  const [loaded, setLoaded] = useState<{ key: string | null; rows: LedgerRow[] }>({
    key: null,
    rows: [],
  });
  const [scanState, setScanState] = useState<ScanState>({ kind: 'idle' });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });

  const rows = loaded.key === key ? loaded.rows : [];

  useEffect(() => {
    if (!userId || !sessionId) return;

    // คีย์รุ่นก่อนไม่มี userId จึงบอกไม่ได้ว่าเป็นของใคร — ทิ้ง ไม่ใช่รับมาเป็นของคนนี้
    purgeLegacyLedgers(localStorage);

    setLoaded({
      key: `${userId}:${sessionId}`,
      rows: loadLedger(localStorage, userId, sessionId),
    });
  }, [userId, sessionId]);

  useEffect(() => {
    if (!userId || !sessionId || loaded.key !== key) return;
    saveLedger(localStorage, userId, sessionId, loaded.rows);
  }, [userId, sessionId, key, loaded]);

  /** อัปเดตแถวโดยไม่หลุดจากคีย์ที่กำลังถืออยู่ */
  const setRows = useCallback(
    (next: LedgerRow[] | ((prev: LedgerRow[]) => LedgerRow[])) => {
      setLoaded((prev) => ({
        key: prev.key,
        rows: typeof next === 'function' ? next(prev.rows) : next,
      }));
    },
    [],
  );

  const scan = useCallback((barcode: string) => {
    const code = barcode.trim();
    if (!code) return;

    setSubmitState({ kind: 'idle' });

    const hit = lookup(code);

    if (!hit) {
      buzz([90, 70, 90]);
      setRows((prev) => applyUnknownScan(prev, code));
      setScanState({ kind: 'unknown', barcode: code });
      return;
    }

    buzz(35);
    setRows((prev) => applyScan(prev, hit));
    setScanState({
      kind: 'found',
      barcode: code,
      key: ledgerKey(hit.sku, hit.barcode),
      uom: hit.uom,
    });
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
      setRows([]);
      setScanState({ kind: 'idle' });
      setSubmitState({ kind: 'done', saved: result.saved });
    } catch (err) {
      setSubmitState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'ส่งผลไม่สำเร็จ ลองใหม่อีกครั้ง',
      });
    }
  }, [sessionId, rows]);

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
