/**
 * สะพานไปยัง ScanBroadcastPlugin ฝั่ง Android
 *
 * เครื่อง PDA ตั้งเป็น Broadcast Mode — ยิงบาร์โค้ดออกมาเป็น Android Intent
 * ไม่ใช่การพิมพ์ตัวอักษร WebView รับเองไม่ได้ ต้องผ่าน plugin native
 *
 * บนเบราว์เซอร์ (ตอน dev) จะไม่มี plugin ตัวนี้ `nativeScannerAvailable` เป็น false
 * แล้ว useScanner ถอยไปใช้ keyboard-wedge แทน เพื่อให้ยังเทสในเครื่องได้
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

/** ค่าที่ยืนยันแล้วจากแอปตั้งค่าสแกนบนเครื่อง */
export const SCAN_ACTION = 'com.kte.scan.result';

export interface ScanEvent {
  /** บาร์โค้ดที่ตัด end mark (\r\n) ออกแล้ว — ว่างได้ถ้ายังหาคีย์ไม่เจอ */
  barcode: string;
  /**
   * ชื่อ extra ที่อ่านค่าได้จริง
   * ไม่มีค่าเมื่อ plugin เดาไม่ออก (JSONObject ตัดคีย์ที่เป็น null ทิ้ง จึงมาเป็น undefined)
   */
  extraKey?: string | null;
  /** ชนิดบาร์โค้ดจาก extra `code_src` เช่น EAN13 / CODE128 — ไว้ debug ตอนอ่านได้แต่ไม่ตรง catalog */
  symbology?: string | null;
  /** extra ทุกตัวใน broadcast ใช้ตอนยังไม่รู้ว่ารุ่นนี้ใช้คีย์ชื่ออะไร */
  extras: Record<string, string>;
}

interface ScanBroadcastPlugin {
  start(options: { action?: string; extraKey?: string }): Promise<{
    action: string;
    extraKey: string | null;
  }>;
  stop(): Promise<void>;
  addListener(
    eventName: 'scan',
    listener: (event: ScanEvent) => void,
  ): Promise<PluginListenerHandle>;
}

const ScanBroadcast = registerPlugin<ScanBroadcastPlugin>('ScanBroadcast');

export const nativeScannerAvailable =
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('ScanBroadcast');

/**
 * ชื่อ extra ที่ค้นเจอบนเครื่องรุ่นนี้ เก็บไว้เพื่อไม่ต้องเดาซ้ำในรอบถัดไป
 *
 * ยังไม่ hardcode ลงโค้ดเพราะยังไม่ได้ยืนยันกับเครื่องจริง —
 * พอรู้แน่แล้วค่อยย้ายไปเป็นค่า default ใน plugin แล้วลบส่วนนี้ทิ้ง
 */
const LEARNED_KEY = 'cc:scanExtraKey';

function learnedKey(): string | undefined {
  try {
    return localStorage.getItem(LEARNED_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function rememberKey(key: string) {
  try {
    if (localStorage.getItem(LEARNED_KEY) !== key) localStorage.setItem(LEARNED_KEY, key);
  } catch {
    /* ไม่เป็นไร แค่ต้องเดาใหม่รอบหน้า */
  }
}

export interface NativeScannerHandle {
  remove(): void;
}

/**
 * เริ่มรับ broadcast แล้วเรียก onScan ทุกครั้งที่ยิงบาร์โค้ด
 * คืน handle ไว้ถอดตอน unmount — คืน null ถ้าไม่ได้อยู่บน native
 */
export async function startNativeScanner(
  onScan: (event: ScanEvent) => void,
): Promise<NativeScannerHandle | null> {
  if (!nativeScannerAvailable) return null;

  const handle = await ScanBroadcast.addListener('scan', (event) => {
    if (event.extraKey) rememberKey(event.extraKey);
    onScan(event);
  });

  await ScanBroadcast.start({ action: SCAN_ACTION, extraKey: learnedKey() });

  return {
    remove() {
      void handle.remove();
      void ScanBroadcast.stop();
    },
  };
}
