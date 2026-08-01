/**
 * Contract test ของสาม endpoint ที่ APK เรียก
 *
 * ## ทำไมต้องมีไฟล์นี้
 *
 * รูปร่าง JSON ของสาม route นี้ถูกตรึงไว้กับ APK ที่อยู่บนเครื่อง PDA แล้ว
 * การเปลี่ยนชื่อฟิลด์ ลบฟิลด์ หรือเปลี่ยน header จะทำให้เครื่องที่ยังไม่ได้อัปเดต
 * ใช้งานไม่ได้ **โดยที่ typecheck ผ่านหมด** เพราะ contract อยู่คนละ process กัน
 *
 * เทสชุดนี้ยืนยันสิ่งที่ฝั่ง PDA พึ่งพาจริง ๆ ตามที่ไล่จากโค้ดของ apps/pda:
 *   - รูปร่าง field ของ response       (lib/api.ts, useLedger.ts)
 *   - ETag + 304                        (lib/api.ts:325-351, catalogCache.ts)
 *   - CORS header สำหรับ if-none-match  (lib/api.ts:333)
 *   - โหมด blind ต้องไม่มี expectedBaseQty แม้แต่ตัวเดียวใน payload
 *
 * ถ้าเทสในไฟล์นี้ล้ม ให้ถามก่อนว่า "APK บนเครื่องรับการเปลี่ยนแปลงนี้ได้ไหม"
 * ไม่ใช่แก้เทสให้ผ่าน
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', async () => {
  const stub = await import('@/test/dbStub');
  return { db: stub.db };
});

vi.mock('@/server/auth', () => ({
  requireUser: vi.fn(),
  requireRole: vi.fn(),
}));

import { requireUser } from '@/server/auth';
import { consumedQueries, queueResults, remainingResults } from '@/test/dbStub';

import { GET as getCatalog, OPTIONS as catalogOptions } from './catalog/route';
import { POST as postCountLines } from './count-lines/route';
import { GET as getSession } from './session/route';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const PROFILE = {
  userId: USER_ID,
  name: 'สมชาย ใจดี',
  employeeCode: 'EMP-2041',
  warehouse: 'คลังกลาง',
  role: 'counter' as const,
  active: true,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

/** รอบนับที่ใช้ร่วมกันหลายเทส — override เฉพาะฟิลด์ที่สนใจ */
const session = (over: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  code: 'CC-2026-07',
  name: 'รอบนับกรกฎาคม',
  location: 'โซน A',
  mode: 'blind',
  status: 'active',
  createdAt: new Date('2026-07-01T00:00:00Z'),
  ...over,
});

/** หนึ่งแถวจาก join ของ catalog — numeric ของ Postgres มาเป็น string เสมอ */
const catalogRow = (over: Record<string, unknown> = {}) => ({
  barcode: '8850001000018',
  sku: '100098',
  name: 'Klean Gauze 2" x 2"',
  uom: 'แผง',
  baseUom: 'แผง',
  location: 'A-01-02',
  factorToBase: '1.0000',
  ...over,
});

function req(url: string, init: RequestInit = {}): Request {
  return new Request(url, init);
}

beforeEach(() => {
  vi.mocked(requireUser).mockResolvedValue({ userId: USER_ID, profile: PROFILE });
  queueResults([]);
});

describe('GET /api/pda/session', () => {
  it('คืน user + session ตามรูปร่างที่ APK อ่าน', async () => {
    queueResults([[session()]]);

    const res = await getSession(req('http://localhost:3000/api/pda/session'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      user: {
        id: USER_ID,
        name: 'สมชาย ใจดี',
        employeeCode: 'EMP-2041',
        warehouse: 'คลังกลาง',
      },
      session: {
        id: SESSION_ID,
        code: 'CC-2026-07',
        location: 'โซน A',
        mode: 'blind',
      },
    });
    expect(remainingResults()).toBe(0);
  });

  it('warehouse/location ที่เป็น null ต้องกลายเป็นสตริงว่าง ไม่ใช่ null', async () => {
    vi.mocked(requireUser).mockResolvedValue({
      userId: USER_ID,
      profile: { ...PROFILE, warehouse: null },
    });
    queueResults([[session({ location: null })]]);

    const body = await (await getSession(req('http://localhost:3000/api/pda/session'))).json();

    expect(body.user.warehouse).toBe('');
    expect(body.session.location).toBe('');
  });

  it('ไม่มีรอบ active → 404 พร้อม { error }', async () => {
    queueResults([[]]);

    const res = await getSession(req('http://localhost:3000/api/pda/session'));

    expect(res.status).toBe(404);
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('GET /api/pda/catalog', () => {
  const url = `http://localhost:3000/api/pda/catalog?sessionId=${SESSION_ID}`;

  /** ลำดับ query ของ route: session → stat(ETag) → rows → [expected ถ้าไม่ blind] */
  const queueCatalog = (
    opts: {
      mode?: string;
      rows?: unknown[];
      expected?: unknown[];
      /** ค่าที่ประกอบเป็น ETag — เปลี่ยนตัวใดตัวหนึ่งแล้ว ETag ต้องเปลี่ยนตาม */
      stat?: Record<string, unknown>;
    } = {},
  ) => {
    const mode = opts.mode ?? 'blind';
    const results: unknown[] = [
      [{ id: SESSION_ID, mode }],
      [
        {
          total: 10841,
          updatedAt: new Date('2026-07-30T10:00:00Z'),
          uomCount: 10763,
          expectedCount: 6696,
          ...opts.stat,
        },
      ],
      opts.rows ?? [catalogRow()],
    ];
    if (mode !== 'blind') results.push(opts.expected ?? []);
    queueResults(results);
  };

  /** ETag ของ request หนึ่งครั้ง ภายใต้ stat ที่กำหนด */
  const etagFor = async (stat?: Record<string, unknown>) => {
    queueCatalog({ stat });
    return (await getCatalog(req(url))).headers.get('etag');
  };

  it('โหมด blind ต้องไม่มีคำว่า expectedBaseQty อยู่ใน payload เลย', async () => {
    queueCatalog({ mode: 'blind' });

    const res = await getCatalog(req(url));
    const raw = await res.text();

    // ตรวจบนสตริงดิบ ไม่ใช่บน object ที่ parse แล้ว — ให้ตรงกับที่ grep ทำได้จริง
    expect(raw).not.toContain('expectedBaseQty');

    const body = JSON.parse(raw);
    expect(body.mode).toBe('blind');
    expect(Object.keys(body.entries[0]).sort()).toEqual([
      'barcode',
      'baseUom',
      'factorToBase',
      'location',
      'name',
      'sku',
      'uom',
    ]);
  });

  it('โหมด recount ใส่ expectedBaseQty เป็นตัวเลขในหน่วยฐาน', async () => {
    queueCatalog({
      mode: 'recount',
      rows: [catalogRow({ factorToBase: '50.0000' })],
      expected: [{ sku: '100098', baseQty: '369.0000' }],
    });

    const body = await (await getCatalog(req(url))).json();

    expect(body.mode).toBe('recount');
    expect(body.entries[0].expectedBaseQty).toBe(369);
    // numeric ของ Postgres เป็น string — ต้องแปลงให้ client ได้ number ล้วน
    expect(body.entries[0].factorToBase).toBe(50);
  });

  it('SKU ที่ไม่มียอดตั้งต้นได้ expectedBaseQty เป็น null ไม่ใช่ขาดคีย์', async () => {
    queueCatalog({ mode: 'recount', expected: [] });

    const body = await (await getCatalog(req(url))).json();

    expect(body.entries[0]).toHaveProperty('expectedBaseQty', null);
  });

  it('ไม่มีแถวใน uom_conversions → factorToBase เป็น 1', async () => {
    queueCatalog({ rows: [catalogRow({ factorToBase: null })] });

    const body = await (await getCatalog(req(url))).json();

    expect(body.entries[0].factorToBase).toBe(1);
  });

  it('ส่ง ETag + Cache-Control ที่ PDA ใช้ทำ conditional GET', async () => {
    queueCatalog();

    const res = await getCatalog(req(url));

    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('if-none-match ตรง → 304 ไม่มี body', async () => {
    queueCatalog();
    const first = await getCatalog(req(url));
    const etag = first.headers.get('etag')!;

    queueCatalog();
    const second = await getCatalog(req(url, { headers: { 'if-none-match': etag } }));

    expect(second.status).toBe(304);
    expect(await second.text()).toBe('');
    // 304 ต้องตอบก่อนสร้าง payload — rows ยังไม่ถูกใช้
    expect(remainingResults()).toBeGreaterThan(0);
  });

  it('ETag ต้องเปลี่ยนเมื่อโหมดเปลี่ยน (กันยอดระบบค้างในเครื่องหลังสลับเป็น blind)', async () => {
    queueCatalog({ mode: 'recount', expected: [] });
    const recountEtag = (await getCatalog(req(url))).headers.get('etag');

    queueCatalog({ mode: 'blind' });
    const blindEtag = (await getCatalog(req(url))).headers.get('etag');

    expect(recountEtag).not.toBe(blindEtag);
  });

  /*
   * payload อ่านจากสี่ตาราง — ETag ต้องขยับตามทุกตัว
   * ก่อนหน้านี้คีย์มีแค่ products กับจำนวนบาร์โค้ด การ import uom/expected
   * จึงไม่ทำให้ ETag เปลี่ยน แล้ว PDA ได้ 304 พร้อมตัวคูณเก่า
   */
  describe('ETag ครอบทุกตารางที่ payload อ่าน', () => {
    it('เท่าเดิมเมื่อไม่มีอะไรเปลี่ยน', async () => {
      expect(await etagFor()).toBe(await etagFor());
    });

    it('เปลี่ยนเมื่อ products ถูกแก้', async () => {
      expect(await etagFor()).not.toBe(
        await etagFor({ updatedAt: new Date('2026-07-31T10:00:00Z') }),
      );
    });

    it('เปลี่ยนเมื่อจำนวนบาร์โค้ดเปลี่ยน', async () => {
      expect(await etagFor()).not.toBe(await etagFor({ total: 10842 }));
    });

    it('เปลี่ยนเมื่อ uom_conversions เปลี่ยน — ตัวคูณผิดต้องไม่ค้างในเครื่อง', async () => {
      expect(await etagFor()).not.toBe(await etagFor({ uomCount: 10764 }));
    });

    it('เปลี่ยนเมื่อ expected_stock ของรอบนี้เปลี่ยน', async () => {
      expect(await etagFor()).not.toBe(await etagFor({ expectedCount: 6700 }));
    });
  });

  it('ไม่ส่ง sessionId → 400 ไม่ใช่ 500', async () => {
    const res = await getCatalog(req('http://localhost:3000/api/pda/catalog'));

    expect(res.status).toBe(400);
    expect(consumedQueries()).toBe(0);
  });

  it('ไม่พบรอบนับ → 404', async () => {
    queueResults([[]]);

    expect((await getCatalog(req(url))).status).toBe(404);
  });
});

describe('POST /api/pda/count-lines', () => {
  const url = 'http://localhost:3000/api/pda/count-lines';

  const line = (over: Record<string, unknown> = {}) => ({
    lineKey: '100098|8850001000018',
    sku: '100098',
    uom: 'แผง',
    factorToBase: 1,
    scannedBarcode: '8850001000018',
    countedQty: 12,
    flagged: false,
    countedAt: '2026-07-31T04:00:00.000Z',
    ...over,
  });

  const post = (body: unknown) =>
    postCountLines(
      req(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('บันทึกสำเร็จ → { saved: number }', async () => {
    queueResults([[{ status: 'active' }], [{ id: 'a' }, { id: 'b' }]]);

    const res = await post({ sessionId: SESSION_ID, lines: [line(), line({ lineKey: 'x|y' })] });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: 2 });
  });

  it('รอบนับปิดแล้ว → 403', async () => {
    queueResults([[{ status: 'closed' }]]);

    const res = await post({ sessionId: SESSION_ID, lines: [line()] });

    expect(res.status).toBe(403);
    expect(await res.json()).toHaveProperty('error');
  });

  it('ไม่พบรอบนับ → 404', async () => {
    queueResults([[]]);

    expect((await post({ sessionId: SESSION_ID, lines: [line()] })).status).toBe(404);
  });

  it('payload ผิดรูป → 400 พร้อมบอกฟิลด์ที่ผิด', async () => {
    const res = await post({ sessionId: 'ไม่ใช่ uuid', lines: [] });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('sessionId');
    expect(consumedQueries()).toBe(0);
  });

  it('body ที่ไม่ใช่ JSON → 400 ไม่ใช่ 500', async () => {
    const res = await postCountLines(
      req(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'ไม่ใช่ json',
      }),
    );

    expect(res.status).toBe(400);
  });
});

describe('CORS', () => {
  /*
   * PDA รันบน origin https://localhost (Capacitor WebView) จึงเป็น cross-origin เสมอ
   * ถ้า if-none-match หลุดจาก Allow-Headers หรือ etag หลุดจาก Expose-Headers
   * เบราว์เซอร์จะบล็อกเงียบ ๆ แล้ว PDA จะดาวน์โหลด catalog 1.5 MB ใหม่ทุกครั้งที่เปิดแอป
   */
  const ORIGIN = 'https://localhost';

  it('preflight ตอบ 204 พร้อม header ที่ conditional GET ต้องใช้', () => {
    const res = catalogOptions(
      req('http://localhost:3000/api/pda/catalog', {
        method: 'OPTIONS',
        headers: { origin: ORIGIN },
      }),
    );

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('access-control-allow-headers')).toContain('if-none-match');
    expect(res.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(res.headers.get('access-control-expose-headers')).toContain('etag');
  });

  it('response จริงก็ต้องมี CORS header ติดไปด้วย', async () => {
    queueResults([[session()]]);

    const res = await getSession(
      req('http://localhost:3000/api/pda/session', { headers: { origin: ORIGIN } }),
    );

    expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('origin ที่ไม่รู้จักไม่ได้ CORS header', async () => {
    queueResults([[session()]]);

    const res = await getSession(
      req('http://localhost:3000/api/pda/session', { headers: { origin: 'https://evil.example' } }),
    );

    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('การจัดการ error', () => {
  it('error ที่ไม่คาดคิดไม่รั่วรายละเอียดออกไป client', async () => {
    vi.mocked(requireUser).mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432'));

    const res = await getSession(req('http://localhost:3000/api/pda/session'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
    expect(body).toEqual({ error: 'เกิดข้อผิดพลาดภายในระบบ' });
  });

  it('ยังไม่ล็อกอิน → 401', async () => {
    const { unauthorized } = await import('@/server/http');
    vi.mocked(requireUser).mockRejectedValue(unauthorized());

    expect((await getSession(req('http://localhost:3000/api/pda/session'))).status).toBe(401);
  });
});

describe('logging', () => {
  it('ทุก response มี x-request-id ให้หน้างานอ้างตอนแจ้งปัญหา', async () => {
    queueResults([[session()]]);

    const res = await getSession(req('http://localhost:3000/api/pda/session'));

    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('ใช้ x-vercel-id เป็น requestId ถ้ามี จะได้ผูกกับ log ของ platform', async () => {
    queueResults([[session()]]);

    const res = await getSession(
      req('http://localhost:3000/api/pda/session', { headers: { 'x-vercel-id': 'sin1::abc123' } }),
    );

    expect(res.headers.get('x-request-id')).toBe('sin1::abc123');
  });

  it('คำขอที่สำเร็จออก log หนึ่งบรรทัดพร้อม method/path/status/durationMs', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    queueResults([[session()]]);

    await getSession(req('http://localhost:3000/api/pda/session'));

    expect(spy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(spy.mock.calls[0]![0] as string);
    expect(logged).toMatchObject({
      level: 'info',
      event: 'request',
      method: 'GET',
      path: '/api/pda/session',
      status: 200,
    });
    expect(typeof logged.durationMs).toBe('number');
    spy.mockRestore();
  });

  it('log ของ error ไม่ออกทาง console.log และไม่ทำให้ response รั่ว', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(requireUser).mockRejectedValue(new Error('boom'));

    await getSession(req('http://localhost:3000/api/pda/session'));

    expect(infoSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(errorSpy.mock.calls[0]![0] as string)).toMatchObject({
      level: 'error',
      status: 500,
      errorMessage: 'boom',
    });
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
});
