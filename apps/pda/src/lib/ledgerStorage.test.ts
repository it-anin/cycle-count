/**
 * เทสของที่เก็บสมุดบัญชี — เน้นกรณี "เครื่องเดียว หลายคน"
 *
 * เทสในไฟล์นี้มีไว้กันบั๊กที่เคยทำให้ผลนับของคนหนึ่งถูกบันทึกในชื่อของอีกคน
 * ถ้าข้อไหนแดง แปลว่าคีย์กลับไปไม่ผูกกับผู้ใช้อีกแล้ว
 */
import { beforeEach, describe, expect, it } from 'vitest';

import type { LedgerRow } from '@cycle-count/core';

import {
  clearAllLedgers,
  ledgerStorageKey,
  loadLedger,
  purgeLegacyLedgers,
  saveLedger,
} from './ledgerStorage';

/** localStorage ปลอมแบบง่าย ๆ — พอสำหรับ getItem/setItem/removeItem/key/length */
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

const USER_A = 'user-aaaa';
const USER_B = 'user-bbbb';
/** ทุกคนได้รอบเดียวกันจาก /api/pda/session — นี่คือหัวใจของบั๊ก */
const SESSION = 'session-shared';

const row = (sku: string): LedgerRow => ({
  key: `${sku}|barcode-${sku}`,
  sku,
  name: `สินค้า ${sku}`,
  baseUom: 'แผง',
  location: 'A-01',
  units: [{ uom: 'แผง', factorToBase: 1, qty: 3, lastBarcode: `barcode-${sku}`, scanCount: 3 }],
  expectedBaseQty: null,
  flagged: false,
  updatedAt: '2026-07-31T04:00:00.000Z',
});

let storage: Storage;

beforeEach(() => {
  storage = fakeStorage();
});

describe('ledgerStorageKey', () => {
  it('คีย์ต้องมีทั้ง userId และ sessionId', () => {
    const key = ledgerStorageKey(USER_A, SESSION);

    expect(key).toContain(USER_A);
    expect(key).toContain(SESSION);
  });

  it('คนละคนในรอบเดียวกันต้องได้คนละคีย์', () => {
    expect(ledgerStorageKey(USER_A, SESSION)).not.toBe(ledgerStorageKey(USER_B, SESSION));
  });
});

describe('การแยกข้อมูลระหว่างผู้ใช้บนเครื่องเดียวกัน', () => {
  it('B ไม่เห็นสมุดของ A ที่ยังไม่ได้ส่ง', () => {
    saveLedger(storage, USER_A, SESSION, [row('100098'), row('100397')]);

    expect(loadLedger(storage, USER_B, SESSION)).toEqual([]);
  });

  it('A กลับมาล็อกอินใหม่ยังได้ของเดิมครบ', () => {
    const rows = [row('100098'), row('100397')];
    saveLedger(storage, USER_A, SESSION, rows);

    // B เข้ามาใช้เครื่องคั่น แล้วนับของตัวเอง
    saveLedger(storage, USER_B, SESSION, [row('999999')]);

    expect(loadLedger(storage, USER_A, SESSION)).toEqual(rows);
  });

  it('B บันทึกทับไม่กระทบของ A', () => {
    saveLedger(storage, USER_A, SESSION, [row('100098')]);
    saveLedger(storage, USER_B, SESSION, [row('222222')]);

    expect(loadLedger(storage, USER_A, SESSION).map((r) => r.sku)).toEqual(['100098']);
    expect(loadLedger(storage, USER_B, SESSION).map((r) => r.sku)).toEqual(['222222']);
  });

  it('คนเดียวกันคนละรอบนับก็ต้องแยกกัน', () => {
    saveLedger(storage, USER_A, 'รอบที่1', [row('100098')]);
    saveLedger(storage, USER_A, 'รอบที่2', [row('222222')]);

    expect(loadLedger(storage, USER_A, 'รอบที่1').map((r) => r.sku)).toEqual(['100098']);
    expect(loadLedger(storage, USER_A, 'รอบที่2').map((r) => r.sku)).toEqual(['222222']);
  });
});

describe('clearAllLedgers', () => {
  it('ล็อกเอาต์แล้วสมุดของทุกคนบนเครื่องต้องหาย', () => {
    saveLedger(storage, USER_A, SESSION, [row('100098')]);
    saveLedger(storage, USER_B, SESSION, [row('222222')]);

    expect(clearAllLedgers(storage)).toBe(2);
    expect(loadLedger(storage, USER_A, SESSION)).toEqual([]);
    expect(loadLedger(storage, USER_B, SESSION)).toEqual([]);
  });

  it('ไม่แตะคีย์ของระบบอื่นที่อยู่ใน localStorage เดียวกัน', () => {
    storage.setItem('cc:scanExtraKey', 'code');
    storage.setItem('sb-auth-token', 'อะไรสักอย่าง');
    saveLedger(storage, USER_A, SESSION, [row('100098')]);

    clearAllLedgers(storage);

    expect(storage.getItem('cc:scanExtraKey')).toBe('code');
    expect(storage.getItem('sb-auth-token')).toBe('อะไรสักอย่าง');
  });
});

describe('purgeLegacyLedgers', () => {
  it('ทิ้งคีย์รุ่นก่อนที่ไม่มี userId — ห้ามยกให้ผู้ใช้ปัจจุบัน', () => {
    // คีย์แบบเก่า: cc:ledger:v2:<sessionId> ไม่รู้ว่าเป็นของใคร
    storage.setItem(`cc:ledger:v2:${SESSION}`, JSON.stringify([row('100098')]));

    expect(purgeLegacyLedgers(storage)).toBe(1);
    expect(storage.getItem(`cc:ledger:v2:${SESSION}`)).toBeNull();
    // และต้องไม่โผล่มาเป็นของใครทั้งนั้น
    expect(loadLedger(storage, USER_A, SESSION)).toEqual([]);
    expect(loadLedger(storage, USER_B, SESSION)).toEqual([]);
  });

  it('ไม่แตะคีย์รุ่นปัจจุบัน', () => {
    saveLedger(storage, USER_A, SESSION, [row('100098')]);
    storage.setItem(`cc:ledger:v2:${SESSION}`, '[]');

    expect(purgeLegacyLedgers(storage)).toBe(1);
    expect(loadLedger(storage, USER_A, SESSION).map((r) => r.sku)).toEqual(['100098']);
  });
});

describe('ความทนทาน', () => {
  it('JSON พังแล้วเริ่มใหม่ ไม่ throw', () => {
    storage.setItem(ledgerStorageKey(USER_A, SESSION), 'ไม่ใช่ json');

    expect(loadLedger(storage, USER_A, SESSION)).toEqual([]);
  });

  it('ค่าที่ไม่ใช่ array ถือว่าว่าง', () => {
    storage.setItem(ledgerStorageKey(USER_A, SESSION), '{"rows":[]}');

    expect(loadLedger(storage, USER_A, SESSION)).toEqual([]);
  });

  it('storage เต็มแล้วไม่ทำให้การนับสะดุด', () => {
    const full = {
      ...fakeStorage(),
      setItem: () => {
        throw new DOMException('QuotaExceededError');
      },
    } as Storage;

    expect(() => saveLedger(full, USER_A, SESSION, [row('100098')])).not.toThrow();
  });
});
