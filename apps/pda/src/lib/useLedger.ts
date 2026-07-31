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

/**
 * v2 = โครง LedgerRow เปลี่ยนเป็นหนึ่งแถวต่อ SKU (มี units ข้างใน)
 * ขึ้นเวอร์ชันเพื่อไม่ให้เครื่องที่มีข้อมูลค้างจากโครงเก่าอ่านแล้วพัง
 */
const storageKey = (sessionId: string) => `cc:ledger:v2:${sessionId}`;

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

/** สั่นสั้น = รับแล้ว, สั่นยาวสองจังหวะ = ไม่รู้จัก (ใช้ตอนไม่ได้มองจอ) */
function buzz(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
  }
}

export function useLedger(sessionId: string | null) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [scanState, setScanState] = useState<ScanState>({ kind: 'idle' });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    if (!sessionId) return;
    setRows(load(sessionId));
    setRestored(true);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !restored) return;
    save(sessionId, rows);
  }, [sessionId, restored, rows]);

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
