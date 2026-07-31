import { useEffect, useRef, useState } from 'react';

import {
  nativeScannerAvailable,
  startNativeScanner,
  type ScanEvent,
} from './nativeScanner';

interface ScannerOptions {
  minLength?: number;
  /**
   * ปิดชั่วคราวตอนที่ผู้ใช้กำลังแก้จำนวนในแถว
   * มีผลเฉพาะโหมด keyboard-wedge — โหมด broadcast ไม่เกี่ยวกับโฟกัส จึงไม่ต้องปิด
   */
  enabled?: boolean;
  /** เรียกเมื่อรับ broadcast ที่หาบาร์โค้ดไม่เจอ ใช้โชว์ extra ทั้งหมดให้ผู้ใช้ดู */
  onUnrecognized?: (event: ScanEvent) => void;
}

/**
 * รับบาร์โค้ดจากเครื่องสแกนของ PDA
 *
 * มีสองทางตามสภาพแวดล้อม:
 *
 * 1. **Broadcast (บน Android จริง)** — เครื่องตั้ง Data Output Mode เป็น Broadcast Mode
 *    บาร์โค้ดมาเป็น Android Intent ผ่าน ScanBroadcastPlugin
 *    ไม่ขึ้นกับโฟกัส บาร์โค้ดจึงไหลลงช่องแก้จำนวนโดยไม่ตั้งใจไม่ได้
 *
 * 2. **keyboard-wedge (บนเบราว์เซอร์ตอน dev)** — ดัก keydown ทั้งหน้าจอ สะสมตัวอักษร
 *    แล้ว emit เมื่อเจอ Enter แยกจากการพิมพ์มือด้วยความเร็วต่ออักขระ
 *    เก็บไว้เพื่อให้ยังเปิด Chrome เทสเลย์เอาต์ได้โดยไม่ต้อง build APK
 */
export function useScanner(onScan: (barcode: string) => void, opts?: ScannerOptions) {
  const buffer = useRef('');
  const lastTime = useRef(0);
  const minLength = opts?.minLength ?? 3;
  const enabled = opts?.enabled ?? true;

  const handler = useRef(onScan);
  handler.current = onScan;
  const unrecognized = useRef(opts?.onUnrecognized);
  unrecognized.current = opts?.onUnrecognized;

  // ── โหมด broadcast ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!nativeScannerAvailable) return;

    let handle: { remove(): void } | null = null;
    let cancelled = false;

    void startNativeScanner((event) => {
      const code = event.barcode.trim();
      if (code.length >= minLength) {
        handler.current(code);
        return;
      }
      // ยิงติดแต่หาคีย์ไม่เจอ — ส่ง extra ทั้งหมดขึ้นไปให้หน้าจอโชว์
      unrecognized.current?.(event);
    }).then((h) => {
      if (cancelled) h?.remove();
      else handle = h;
    });

    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [minLength]);

  // ── โหมด keyboard-wedge (เบราว์เซอร์เท่านั้น) ─────────────────────────────
  useEffect(() => {
    if (nativeScannerAvailable) return;

    if (!enabled) {
      buffer.current = '';
      return;
    }

    const INTERCHAR_MS = 50; // อักขระจาก scanner มาถี่กว่านี้

    function onKeyDown(e: KeyboardEvent) {
      const now = Date.now();
      // ถ้าเว้นนานเกิน = เริ่ม buffer ใหม่ (กันปนกับพิมพ์มือ)
      if (now - lastTime.current > INTERCHAR_MS) buffer.current = '';
      lastTime.current = now;

      if (e.key === 'Enter') {
        const code = buffer.current.trim();
        buffer.current = '';
        if (code.length >= minLength) {
          e.preventDefault();
          handler.current(code);
        }
        return;
      }

      if (e.key.length === 1) {
        buffer.current += e.key;
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [minLength, enabled]);
}

/**
 * เก็บ broadcast ที่หาบาร์โค้ดไม่เจอไว้ตัวล่าสุด
 *
 * ยิงบาร์โค้ดหนึ่งครั้งแล้วอ่านจากจอ PDA ได้เลยว่าเครื่องรุ่นนี้ใส่บาร์โค้ดไว้ใน extra ชื่ออะไร
 * ไม่ต้องต่อสายดู logcat — พอรู้แล้วค่อยเอาชื่อไปใส่เป็นค่า default ใน plugin
 */
export function useScanDiagnostics() {
  const [lastUnrecognized, setLastUnrecognized] = useState<ScanEvent | null>(null);
  return {
    lastUnrecognized,
    onUnrecognized: setLastUnrecognized,
    clear: () => setLastUnrecognized(null),
  };
}
