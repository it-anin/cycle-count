/**
 * ชั้นข้อมูลของแอป PDA
 *
 * เลือก implementation ตอน runtime:
 *   - ไม่ตั้ง VITE_API_BASE_URL → mock catalog ในเครื่อง (รัน `pnpm dev` แล้วลองสแกนได้ทันที)
 *   - ตั้ง VITE_API_BASE_URL    → ยิง HTTP ไปที่ Next.js route handlers
 *
 * จุดสำคัญของการออกแบบ: **ไม่มีการยิง HTTP ต่อการสแกนหนึ่งครั้ง**
 * catalog ทั้งรอบถูกโหลดลง IndexedDB ตอนเปิดรอบนับ แล้ว lookup() ค้นจาก Map ในหน่วยความจำ
 * จึงเป็น sync และตอบทันที ต่อให้ Wi-Fi ดีแค่ไหน "ทันที" ก็ยังชนะ "50 ms + รอ"
 * เมื่อพนักงานต้องยิงติดกันหลายร้อยครั้ง
 *
 * endpoint ที่ฝั่ง web ต้องมี:
 *   GET  /api/pda/session               → { user, session }
 *   GET  /api/pda/catalog?sessionId=... → { sessionId, generatedAt, entries }
 *   POST /api/pda/count-lines           → { saved }
 */
import type { BarcodeLookup, CountLinePayload, CountMode, SubmitVariance } from '@cycle-count/core';
import { authEmailForEmployee } from '@cycle-count/core';

import { indexEntries, readCatalog, writeCatalog, type CatalogSnapshot } from './catalogCache';
import { accessToken, supabase } from './supabase';

export interface CurrentUser {
  id: string;
  name: string;
  employeeCode: string;
  warehouse: string;
}

export interface SessionInfo {
  id: string;
  code: string;
  location: string;
  /** blind = รอบนี้ไม่มียอดระบบให้เห็น (server ไม่ส่งลงมา) */
  mode: CountMode;
}

export interface CatalogStatus {
  entryCount: number;
  /** version เดียวกับที่ต้องส่งกลับไปตอน submit */
  catalogVersion: string;
  /** true = ใช้ของเดิมในเครื่อง ไม่ได้โหลดใหม่ */
  fromCache: boolean;
}

export interface SubmitResult {
  saved: number;
  /** ใบเฉลยผลต่าง — server คำนวณให้หลังบันทึกเสร็จ ไม่ได้คิดในเครื่อง */
  variance: SubmitVariance;
}

export class CatalogStaleError extends Error {
  constructor(readonly currentVersion: string | null) {
    super('รายการสินค้าในระบบมีการอัปเดต กรุณาตรวจสอบก่อนส่งอีกครั้ง');
    this.name = 'CatalogStaleError';
  }
}

export interface CountApi {
  /** ล็อกอินด้วยรหัสพนักงาน + PIN — โหมด mock ผ่านทุกกรณี */
  signIn(employeeCode: string, pin: string): Promise<void>;
  signOut(): Promise<void>;
  /** null = ยังไม่ได้ล็อกอิน */
  currentSessionToken(): Promise<string | null>;
  bootstrap(): Promise<{ user: CurrentUser; session: SessionInfo }>;
  /** โหลด catalog ของรอบนับลงเครื่อง เรียกครั้งเดียวตอนเปิดรอบ */
  loadCatalog(sessionId: string): Promise<CatalogStatus>;
  submit(input: {
    sessionId: string;
    /** optional เพื่อให้ mock/โค้ดเก่าที่ยังไม่พก version ใช้ interface เดิมได้ */
    catalogVersion?: string;
    lines: CountLinePayload[];
  }): Promise<SubmitResult>;
}

/* -------------------------------------------------------------------------- */
/*                    index ในหน่วยความจำ — ใช้ร่วมทั้งสองโหมด                  */
/* -------------------------------------------------------------------------- */

let catalogIndex: Map<string, BarcodeLookup> | null = null;

/**
 * ค้นบาร์โค้ดจาก index ในเครื่อง — **sync** ไม่แตะเน็ต
 * คืน null ทั้งกรณีไม่พบบาร์โค้ด และกรณียังไม่ได้โหลด catalog
 * (หน้าจอนับจะ mount ก็ต่อเมื่อโหลดเสร็จแล้ว จึงเหลือแค่กรณีแรก)
 */
export function lookup(barcode: string): BarcodeLookup | null {
  return catalogIndex?.get(barcode) ?? null;
}

export function catalogSize(): number {
  return catalogIndex?.size ?? 0;
}

/* -------------------------------------------------------------------------- */
/*                            Mock (ใช้ตอน dev)                                */
/* -------------------------------------------------------------------------- */

interface MockUnit {
  uom: string;
  barcode: string;
  /** ตัวคูณเป็นหน่วยฐาน — ยิงบาร์โค้ดกล่องหนึ่งครั้ง = factorToBase หน่วยฐาน */
  factorToBase: number;
}

interface MockProduct {
  sku: string;
  name: string;
  location: string;
  baseUom: string;
  /** ยอดตั้งต้นของทั้ง SKU ในหน่วยฐาน — null = รอบนี้ไม่มี snapshot */
  expectedBaseQty: number | null;
  units: MockUnit[];
}

/**
 * ตัวอย่างสินค้ายา ให้โครงเหมือน public.stock ของจริง
 * ครบทุกเคสที่ต้องเทส: หน่วยเดียว, หลายหน่วยตัวคูณต่างกัน, ไม่มียอดตั้งต้น
 */
const MOCK_CATALOG: MockProduct[] = [
  {
    sku: '100039',
    name: "AMK 1000 mg 1×10's (กล่อง 1 แผง)",
    location: 'A-01-01',
    baseUom: 'กล่อง',
    expectedBaseQty: 369,
    units: [
      { uom: 'กล่อง', barcode: '8851111100039', factorToBase: 1 },
      { uom: 'ลัง', barcode: '8759991100039', factorToBase: 12 },
    ],
  },
  {
    sku: '100098',
    name: "Antacil (แผง) 50×10's",
    location: 'A-01-02',
    baseUom: 'แผง',
    expectedBaseQty: 580,
    units: [
      { uom: 'แผง', barcode: '8851111100098', factorToBase: 1 },
      { uom: 'กล่อง', barcode: '8759991100098', factorToBase: 50 },
    ],
  },
  {
    sku: '100237',
    name: "Bilaxten 20 mg 1×10's",
    location: 'A-01-03',
    baseUom: 'แผง',
    expectedBaseQty: 148,
    units: [{ uom: 'แผง', barcode: '8851111100237', factorToBase: 1 }],
  },
  {
    sku: '100272',
    name: "CA-R-BON 10×10's",
    location: 'A-02-01',
    baseUom: 'แผง',
    expectedBaseQty: 570,
    units: [{ uom: 'แผง', barcode: '8851111100272', factorToBase: 1 }],
  },
  {
    sku: '100397',
    name: 'Eno ซอง Orange (60ซอง/bx)',
    location: 'A-02-02',
    baseUom: 'ซอง',
    expectedBaseQty: 540,
    units: [
      { uom: 'ซอง', barcode: '8851111100397', factorToBase: 1 },
      { uom: 'กล่อง', barcode: '8759991100397', factorToBase: 60 },
    ],
  },
  {
    sku: '100447',
    name: 'Gaviscon Dual (ซอง-ชมพู) 24×10 ml',
    location: 'A-02-03',
    baseUom: 'ซอง',
    expectedBaseQty: 158,
    units: [{ uom: 'ซอง', barcode: '8851111100447', factorToBase: 1 }],
  },
  {
    sku: '100574',
    name: "Miracid 20 mg 1×14's (กล่อง1แผง)",
    location: 'A-03-01',
    baseUom: 'กล่อง',
    expectedBaseQty: 450,
    units: [{ uom: 'กล่อง', barcode: '8851111100574', factorToBase: 1 }],
  },
  {
    sku: '101357',
    name: "Celxib 200 mg 1×10's NEW 06-26",
    location: 'A-03-02',
    baseUom: 'กล่อง',
    expectedBaseQty: 0,
    units: [{ uom: 'กล่อง', barcode: '8851111101357', factorToBase: 1 }],
  },
  {
    sku: '100625',
    name: "Nasolin PL 1×10's (PK24)",
    location: 'A-03-03',
    baseUom: 'แผง',
    // ยังไม่ได้ snapshot ยอดตั้งต้นของตัวนี้ — ใช้ทดสอบแถวที่ยังตัดสินผลต่างไม่ได้
    expectedBaseQty: null,
    units: [{ uom: 'แผง', barcode: '8851111100625', factorToBase: 1 }],
  },
];

/** สลับโหมดตอน dev เพื่อดูหน้าจอทั้งสองแบบโดยไม่ต้องมี backend */
const mockMode: CountMode =
  (import.meta.env.VITE_MOCK_MODE as CountMode | undefined) === 'recount' ? 'recount' : 'blind';

const MOCK_ENTRIES: BarcodeLookup[] = MOCK_CATALOG.flatMap((p) =>
  p.units.map((u) => ({
    barcode: u.barcode,
    sku: p.sku,
    name: p.name,
    uom: u.uom,
    factorToBase: u.factorToBase,
    baseUom: p.baseUom,
    // เลียนแบบ server: โหมด blind ไม่มียอดระบบส่งลงมาเลย
    expectedBaseQty: mockMode === 'blind' ? null : p.expectedBaseQty,
    location: p.location,
  })),
);

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const mockApi: CountApi = {
  async signIn() {
    await delay(200);
  },

  async signOut() {
    /* mock ไม่มี session ให้ล้าง */
  },

  async currentSessionToken() {
    return 'mock-token';
  },

  async bootstrap() {
    await delay(120);
    return {
      user: {
        id: 'mock-user',
        name: 'สมชาย ป.',
        employeeCode: 'EMP-2041',
        warehouse: 'คลัง A',
      },
      session: {
        id: 'mock-session',
        code: 'CC-2607-A',
        location: 'โซน A-12',
        mode: mockMode,
      },
    };
  },

  async loadCatalog() {
    await delay(250);
    catalogIndex = indexEntries(MOCK_ENTRIES);
    return { entryCount: catalogIndex.size, catalogVersion: 'mock-catalog-v1', fromCache: false };
  },

  async submit({ lines }) {
    await delay(400);

    /*
     * ปลอมใบเฉลยให้หน้าจอมีของจริงให้แสดงตอน dev — SKU ที่ 3 ให้ขาด SKU ที่ 5 ให้เกิน
     * ใช้ลำดับแทนการสุ่ม เพื่อให้กดส่งกี่ครั้งก็ได้ผลเดิม เทียบหน้าจอง่ายกว่า
     */
    const byBase = new Map<string, { name: string; baseUom: string; base: number }>();
    let unknown = 0;

    for (const line of lines) {
      if (line.flagged || !line.sku) {
        unknown += 1;
        continue;
      }
      const hit = catalogIndex?.get(line.scannedBarcode);
      const prev = byBase.get(line.sku);
      byBase.set(line.sku, {
        name: hit?.name ?? line.sku,
        baseUom: hit?.baseUom ?? 'ชิ้น',
        base: (prev?.base ?? 0) + line.countedQty * line.factorToBase,
      });
    }

    const variance: SubmitVariance = {
      matched: 0,
      short: 0,
      over: 0,
      unknown,
      withoutExpected: 0,
      items: [],
    };

    [...byBase.entries()].forEach(([sku, v], i) => {
      const offset = i % 5 === 2 ? -12 : i % 5 === 4 ? 5 : 0;
      const expectedBaseQty = v.base - offset;

      if (offset === 0) {
        variance.matched += 1;
        return;
      }
      if (offset < 0) variance.short += 1;
      else variance.over += 1;

      variance.items.push({
        sku,
        name: v.name,
        baseUom: v.baseUom,
        countedBaseQty: v.base,
        expectedBaseQty,
        diff: offset,
      });
    });

    return { saved: lines.length, variance };
  },
};

/** บาร์โค้ดตัวอย่างไว้กดทดสอบตอนไม่มีเครื่องสแกน */
export const mockBarcodes = MOCK_ENTRIES.map((e) => e.barcode);

/* -------------------------------------------------------------------------- */
/*                          HTTP (Next.js route handlers)                      */
/* -------------------------------------------------------------------------- */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res
      .json()
      .then((value: unknown) => value as { code?: string; error?: string; currentVersion?: string })
      .catch(() => null);

    if (res.status === 409 && body?.code === 'CATALOG_STALE') {
      throw new CatalogStaleError(body.currentVersion ?? null);
    }

    throw new Error(body?.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function createHttpApi(baseUrl: string): CountApi {
  const base = baseUrl.replace(/\/$/, '');

  /** ทุกคำขอต้องพก access token เพราะ PDA อยู่คนละ origin ใช้ cookie ไม่ได้ */
  async function authHeaders(): Promise<Record<string, string>> {
    const token = await accessToken();
    if (!token) throw new Error('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่');
    return { authorization: `Bearer ${token}` };
  }

  return {
    async signIn(employeeCode, pin) {
      if (!supabase) throw new Error('ยังไม่ได้ตั้งค่า VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');

      const { error } = await supabase.auth.signInWithPassword({
        email: authEmailForEmployee(employeeCode),
        password: pin,
      });
      if (!error) return;

      /*
       * ต้องแยก "รหัสผิด" ออกจาก "ต่อไม่ได้" ให้ชัด
       *
       * ล็อกอินคุยกับ Supabase บนอินเทอร์เน็ตโดยตรง ไม่ได้ผ่าน API ใน LAN
       * ถ้า Wi-Fi คลังออกเน็ตไม่ได้ การล็อกอินจะล้มด้วยสาเหตุคนละเรื่องกับรหัสผิด
       * ถ้าเหมารวมเป็น "รหัสไม่ถูกต้อง" หมด คนหน้างานจะไล่แก้ผิดจุดจนหมดวัน
       */
      const status = (error as { status?: number }).status;
      const wrongCredential = status === 400 || error.message.toLowerCase().includes('credential');

      if (wrongCredential) {
        // ไม่บอกว่าผิดที่รหัสพนักงานหรือ PIN — กันการไล่เดารหัสพนักงานที่มีอยู่จริง
        throw new Error('รหัสพนักงานหรือ PIN ไม่ถูกต้อง');
      }

      throw new Error(
        `เชื่อมต่อเซิร์ฟเวอร์ยืนยันตัวตนไม่ได้ — ตรวจว่าเครื่องออกอินเทอร์เน็ตได้\n` +
          `(${error.name}${status ? ' ' + status : ''}: ${error.message})`,
      );
    },

    async signOut() {
      await supabase?.auth.signOut();
      catalogIndex = null;
    },

    async currentSessionToken() {
      return accessToken();
    },

    async bootstrap() {
      return json(await fetch(`${base}/api/pda/session`, { headers: await authHeaders() }));
    },

    async loadCatalog(sessionId) {
      const cached = await readCatalog(sessionId);

      const res = await fetch(
        `${base}/api/pda/catalog?sessionId=${encodeURIComponent(sessionId)}`,
        {
          headers: {
            ...(await authHeaders()),
            ...(cached?.catalogVersion && cached.etag ? { 'if-none-match': cached.etag } : {}),
          },
        },
      );

      // master ไม่เปลี่ยนตั้งแต่โหลดครั้งก่อน — ใช้ของในเครื่องต่อได้เลย
      if (res.status === 304 && cached) {
        catalogIndex = indexEntries(cached.entries);
        return {
          entryCount: catalogIndex.size,
          catalogVersion: cached.catalogVersion,
          fromCache: true,
        };
      }

      const body = await json<Omit<CatalogSnapshot, 'etag'>>(res);
      const snapshot: CatalogSnapshot = { ...body, etag: res.headers.get('etag') };

      catalogIndex = indexEntries(snapshot.entries);
      await writeCatalog(snapshot);

      return {
        entryCount: catalogIndex.size,
        catalogVersion: snapshot.catalogVersion,
        fromCache: false,
      };
    },

    async submit(input) {
      return json(
        await fetch(`${base}/api/pda/count-lines`, {
          method: 'POST',
          headers: { ...(await authHeaders()), 'content-type': 'application/json' },
          body: JSON.stringify(input),
        }),
      );
    },
  };
}

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL as string | undefined;

export const api: CountApi = apiBaseUrl ? createHttpApi(apiBaseUrl) : mockApi;
export const usingMock = !apiBaseUrl;
