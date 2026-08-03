/**
 * เทสว่า stub ใน index.html รับ lifecycle event ก่อน bridge พร้อมได้โดยไม่พัง
 * และไม่ขวางไม่ให้ bridge ตัวจริงเข้ามาทำงานทีหลัง
 *
 * เทสตัวสคริปต์ที่ฝังใน index.html ตรง ๆ ไม่ได้ จึงจำลองพฤติกรรมสองอย่างที่พึ่งพา:
 *   1. สคริปต์ของเรา   — วาง stub ถ้ายังไม่มี triggerEvent
 *   2. Capacitor ของจริง — `const cap = win.Capacitor || {}` แล้วเขียนทับ (ยืนยันจาก
 *      @capacitor/core@6.2.1 dist/index.cjs.js:111 และ android native-bridge.js)
 *
 * ถ้าวันหนึ่ง Capacitor เปลี่ยนไปเป็น "ถ้ามี window.Capacitor แล้วให้ข้าม"
 * เทสข้อสุดท้ายจะยังเขียว แต่ของจริงจะพัง — จึงต้องตรวจซ้ำเวลาอัป Capacitor major
 */
import { beforeEach, describe, expect, it } from 'vitest';

interface CapWindow {
  Capacitor?: {
    triggerEvent?: (eventName: string, target: string, eventData?: unknown) => boolean;
    __earlyEvents?: { eventName: string; target: string; eventData?: unknown }[];
    Plugins?: Record<string, unknown>;
  };
}

/** สำเนาของสคริปต์ที่อยู่ใน index.html */
function installGuard(win: CapWindow): void {
  win.Capacitor = win.Capacitor || {};
  if (typeof win.Capacitor.triggerEvent !== 'function') {
    win.Capacitor.__earlyEvents = [];
    win.Capacitor.triggerEvent = (eventName, target, eventData) => {
      win.Capacitor!.__earlyEvents!.push({ eventName, target, eventData });
      return false;
    };
  }
}

/** จำลองสิ่งที่ native-bridge.js ทำตอน bridge พร้อม */
function installRealBridge(win: CapWindow): void {
  const cap = win.Capacitor || {};
  cap.Plugins = { ScanBroadcast: {} };
  cap.triggerEvent = () => true;
  win.Capacitor = cap;
}

let win: CapWindow;

beforeEach(() => {
  win = {};
});

describe('stub ที่กันจอขาว', () => {
  it('ยิง triggerEvent ก่อน bridge พร้อม ต้องไม่ throw', () => {
    installGuard(win);

    expect(() => win.Capacitor!.triggerEvent!('pause', 'document')).not.toThrow();
  });

  it('ถ้าไม่มี stub จะพังแบบเดียวกับที่เจอบนเครื่องจริง', () => {
    // ไม่เรียก installGuard — นี่คือสภาพก่อนแก้
    const bare = win as unknown as { Capacitor: { triggerEvent: () => void } };

    expect(() => bare.Capacitor.triggerEvent()).toThrow(TypeError);
  });

  it('เก็บ event ที่มาก่อนเวลาไว้ให้ตามดูได้', () => {
    installGuard(win);

    win.Capacitor!.triggerEvent!('pause', 'document');
    win.Capacitor!.triggerEvent!('resume', 'document');

    expect(win.Capacitor!.__earlyEvents).toEqual([
      { eventName: 'pause', target: 'document', eventData: undefined },
      { eventName: 'resume', target: 'document', eventData: undefined },
    ]);
  });

  it('bridge ตัวจริงเข้ามาแล้วต้องเขียนทับ stub ได้ และ plugin ยังติดครบ', () => {
    installGuard(win);
    win.Capacitor!.triggerEvent!('pause', 'document');

    installRealBridge(win);

    expect(win.Capacitor!.triggerEvent!('resume', 'document')).toBe(true);
    expect(win.Capacitor!.Plugins).toHaveProperty('ScanBroadcast');
  });

  it('เรียก installGuard ซ้ำต้องไม่ทับ triggerEvent ของจริงที่ติดตั้งไปแล้ว', () => {
    installRealBridge(win);
    installGuard(win);

    expect(win.Capacitor!.triggerEvent!('pause', 'document')).toBe(true);
  });
});
