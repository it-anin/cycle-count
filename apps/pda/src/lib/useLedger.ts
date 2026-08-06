/**
 * สถานะสมุดบัญชีของหน้าจอนับสต็อก
 *
 * สมุดผูกกับ catalogVersion ที่ใช้ตอนนับ เพื่อไม่ให้เปิดแอปใหม่แล้ว catalog เปลี่ยน
 * แต่ยังส่ง factor/SKU เก่าที่ค้างใน localStorage ขึ้น server โดยไม่รู้ตัว
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  applyScan,
  applyUnknownScan,
  bumpUnitQty as bumpUnitQtyPure,
  countedBaseQty,
  ledgerKey,
  ledgerTotals,
  reconcileLedgerCatalog,
  removeRow as removeRowPure,
  removeUnit as removeUnitPure,
  setUnitQty as setUnitQtyPure,
  toCountLines,
  type CatalogConflict,
  type LedgerRow,
  type SubmitVariance,
} from '@cycle-count/core';

import { api, CatalogStaleError, lookup } from './api';
import { loadLocked, saveLocked, type LockedEntry } from './submittedLog';

export type ScanState =
  | { kind: 'idle' }
  | { kind: 'found'; barcode: string; key: string; uom: string }
  | { kind: 'unknown'; barcode: string }
  | { kind: 'locked'; barcode: string; key: string; entry: LockedEntry };

export type SubmitState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; saved: number; variance: SubmitVariance }
  | { kind: 'error'; message: string };

export type SubmitOutcome = 'done' | 'conflict' | 'error' | 'noop';

interface StoredLedger {
  catalogVersion: string | null;
  rows: LedgerRow[];
}

/** v3 เพิ่ม catalogVersion ครอบ rows; v2 ยังอ่านเพื่อย้ายยอดค้างโดยไม่ลบทิ้ง */
const storageKey = (sessionId: string) => `cc:ledger:v3:${sessionId}`;
const legacyStorageKey = (sessionId: string) => `cc:ledger:v2:${sessionId}`;
const SAVE_DEBOUNCE_MS = 800;

function load(sessionId: string): StoredLedger {
  try {
    const raw = localStorage.getItem(storageKey(sessionId));
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        const candidate = parsed as Partial<StoredLedger>;
        if (Array.isArray(candidate.rows)) {
          return {
            catalogVersion:
              typeof candidate.catalogVersion === 'string' ? candidate.catalogVersion : null,
            rows: candidate.rows as LedgerRow[],
          };
        }
      }
    }
  } catch {
    // ลอง v2 ต่อด้านล่าง — v3 พังต้องไม่ทำให้จอขาว
  }

  try {
    const raw = localStorage.getItem(legacyStorageKey(sessionId));
    if (!raw) return { catalogVersion: null, rows: [] };
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? { catalogVersion: null, rows: parsed as LedgerRow[] }
      : { catalogVersion: null, rows: [] };
  } catch {
    return { catalogVersion: null, rows: [] };
  }
}

function save(sessionId: string, ledger: StoredLedger) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(ledger));
  } catch {
    // เต็ม/โดนปิด — ไม่ควรทำให้การนับสะดุด
  }
}

function buzz(pattern: number | number[]) {
  if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
    navigator.vibrate(pattern);
  }
}

const LOCKED_BUZZ = 220;

export function useLedger(sessionId: string | null, initialCatalogVersion: string) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [scanState, setScanState] = useState<ScanState>({ kind: 'idle' });
  const [submitState, setSubmitState] = useState<SubmitState>({ kind: 'idle' });
  const [catalogConflicts, setCatalogConflicts] = useState<CatalogConflict[]>([]);
  const [restored, setRestored] = useState(false);

  const rowsRef = useRef<LedgerRow[]>([]);
  const conflictsRef = useRef<CatalogConflict[]>([]);
  const activeCatalogVersion = useRef(initialCatalogVersion);
  const ledgerCatalogVersion = useRef<string | null>(initialCatalogVersion);
  const locked = useRef<Map<string, LockedEntry>>(new Map());

  const replaceRows = useCallback((next: LedgerRow[]) => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const replaceConflicts = useCallback((next: CatalogConflict[]) => {
    conflictsRef.current = next;
    setCatalogConflicts(next);
  }, []);

  /** เทียบ rows กับ index ล่าสุด และ bind version เมื่อไม่มีรายการที่ต้องนับใหม่ */
  const reconcileCurrent = useCallback(
    (candidate: LedgerRow[]): LedgerRow[] => {
      const reconciled = reconcileLedgerCatalog(candidate, lookup);
      replaceConflicts(reconciled.conflicts);
      if (reconciled.conflicts.length === 0) {
        ledgerCatalogVersion.current = activeCatalogVersion.current;
      }
      return reconciled.rows;
    },
    [replaceConflicts],
  );

  useEffect(() => {
    if (!sessionId) return;

    setRestored(false);
    activeCatalogVersion.current = initialCatalogVersion;

    const stored = load(sessionId);
    ledgerCatalogVersion.current = stored.catalogVersion;

    const restoredRows =
      stored.catalogVersion === initialCatalogVersion ? stored.rows : reconcileCurrent(stored.rows);

    replaceRows(restoredRows);
    if (stored.catalogVersion === initialCatalogVersion) replaceConflicts([]);

    locked.current = loadLocked(sessionId);
    setRestored(true);
  }, [sessionId, initialCatalogVersion, reconcileCurrent, replaceConflicts, replaceRows]);

  /* เขียนลงเครื่องแบบ debounce แต่ flush ทันทีเมื่อ WebView หายจากหน้าจอ */
  const pending = useRef<{ sessionId: string; ledger: StoredLedger } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    if (due) save(due.sessionId, due.ledger);
  }, [cancelPendingSave]);

  useEffect(() => {
    if (!sessionId || !restored) return;

    pending.current = {
      sessionId,
      ledger: { catalogVersion: ledgerCatalogVersion.current, rows },
    };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  }, [sessionId, restored, rows, flush]);

  useEffect(() => {
    function onHide() {
      if (document.visibilityState === 'hidden') flush();
    }
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);

    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      flush();
    };
  }, [flush]);

  const scan = useCallback(
    (barcode: string) => {
      if (conflictsRef.current.length > 0) {
        buzz(LOCKED_BUZZ);
        return;
      }

      const code = barcode.trim();
      if (!code) return;

      setSubmitState({ kind: 'idle' });

      const hit = lookup(code);
      const key = ledgerKey(hit?.sku ?? null, hit?.barcode ?? code);
      const already = locked.current.get(key);
      if (already) {
        buzz(LOCKED_BUZZ);
        setScanState({ kind: 'locked', barcode: code, key, entry: already });
        return;
      }

      if (!hit) {
        buzz([90, 70, 90]);
        replaceRows(applyUnknownScan(rowsRef.current, code));
        setScanState({ kind: 'unknown', barcode: code });
        return;
      }

      buzz(35);
      replaceRows(applyScan(rowsRef.current, hit));
      setScanState({ kind: 'found', barcode: code, key, uom: hit.uom });
    },
    [replaceRows],
  );

  const setUnitQty = useCallback(
    (key: string, uom: string, qty: number) => {
      if (conflictsRef.current.length > 0) return;
      replaceRows(setUnitQtyPure(rowsRef.current, key, uom, qty));
    },
    [replaceRows],
  );

  const bumpUnitQty = useCallback(
    (key: string, uom: string, delta: number) => {
      if (conflictsRef.current.length > 0) return;
      replaceRows(bumpUnitQtyPure(rowsRef.current, key, uom, delta));
    },
    [replaceRows],
  );

  const removeUnit = useCallback(
    (key: string, uom: string) => {
      const next = removeUnitPure(rowsRef.current, key, uom);
      replaceRows(conflictsRef.current.length > 0 ? reconcileCurrent(next) : next);
      setScanState({ kind: 'idle' });
    },
    [reconcileCurrent, replaceRows],
  );

  const removeRow = useCallback(
    (key: string) => {
      const next = removeRowPure(rowsRef.current, key);
      replaceRows(conflictsRef.current.length > 0 ? reconcileCurrent(next) : next);
      setScanState({ kind: 'idle' });
    },
    [reconcileCurrent, replaceRows],
  );

  const submit = useCallback(async (): Promise<SubmitOutcome> => {
    if (!sessionId || rowsRef.current.length === 0) return 'noop';
    if (conflictsRef.current.length > 0) return 'conflict';

    setSubmitState({ kind: 'sending' });

    const finishSuccess = (
      submittedRows: LedgerRow[],
      result: Awaited<ReturnType<typeof api.submit>>,
    ) => {
      const submittedAt = new Date().toISOString();
      const nextLocked = new Map(locked.current);
      for (const row of submittedRows) {
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

      replaceRows([]);
      replaceConflicts([]);
      ledgerCatalogVersion.current = activeCatalogVersion.current;

      cancelPendingSave();
      save(sessionId, {
        catalogVersion: ledgerCatalogVersion.current,
        rows: [],
      });

      setScanState({ kind: 'idle' });
      setSubmitState({ kind: 'done', saved: result.saved, variance: result.variance });
    };

    const send = async (submittedRows: LedgerRow[], retried: boolean): Promise<SubmitOutcome> => {
      try {
        const result = await api.submit({
          sessionId,
          catalogVersion: activeCatalogVersion.current,
          lines: toCountLines(submittedRows),
        });
        finishSuccess(submittedRows, result);
        return 'done';
      } catch (err) {
        if (err instanceof CatalogStaleError && !retried) {
          const fresh = await api.loadCatalog(sessionId);
          activeCatalogVersion.current = fresh.catalogVersion;

          const reconciled = reconcileLedgerCatalog(submittedRows, lookup);
          replaceRows(reconciled.rows);
          replaceConflicts(reconciled.conflicts);

          if (reconciled.conflicts.length > 0) {
            /* เก็บ version เดิมไว้จนกว่ารายการที่ตีความไม่ได้จะถูกลบและนับใหม่ */
            cancelPendingSave();
            save(sessionId, {
              catalogVersion: ledgerCatalogVersion.current,
              rows: reconciled.rows,
            });
            setSubmitState({ kind: 'idle' });
            return 'conflict';
          }

          ledgerCatalogVersion.current = fresh.catalogVersion;
          cancelPendingSave();
          save(sessionId, {
            catalogVersion: fresh.catalogVersion,
            rows: reconciled.rows,
          });

          return send(reconciled.rows, true);
        }

        if (err instanceof CatalogStaleError) {
          throw new Error('รายการสินค้าเปลี่ยนอีกครั้งระหว่างตรวจ กรุณากดส่งใหม่');
        }
        throw err;
      }
    };

    try {
      return await send(rowsRef.current, false);
    } catch (err) {
      setSubmitState({
        kind: 'error',
        message: err instanceof Error ? err.message : 'ส่งผลไม่สำเร็จ ลองใหม่อีกครั้ง',
      });
      return 'error';
    }
  }, [sessionId, cancelPendingSave, replaceConflicts, replaceRows]);

  const dismissSubmit = useCallback(() => setSubmitState({ kind: 'idle' }), []);

  return {
    rows,
    totals: ledgerTotals(rows),
    scanState,
    submitState,
    catalogConflicts,
    scan,
    setUnitQty,
    bumpUnitQty,
    removeUnit,
    removeRow,
    submit,
    dismissSubmit,
  };
}
