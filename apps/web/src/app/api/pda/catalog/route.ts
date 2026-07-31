/**
 * GET /api/pda/catalog?sessionId=... — index บาร์โค้ดทั้งรอบนับ
 *
 * PDA โหลดก้อนนี้ครั้งเดียวตอนเปิดรอบ แล้วค้นในเครื่อง
 * แทนการยิง HTTP ต่อการสแกนหนึ่งครั้ง — สแกนแล้วตอบทันที ไม่มีสปินเนอร์
 *
 * 20,000 บาร์โค้ด ≈ 2 MB JSON (~400 KB หลัง gzip ซึ่ง Vercel ทำให้อัตโนมัติ)
 */
import { and, count, eq, max, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { barcodes, countSessions, expectedStock, products, uomConversions } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireUser } from '@/server/auth';
import { badRequest, notFound, preflight, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export const OPTIONS = preflight;

export const GET = withApi(async (req) => {
  await requireUser(req);

  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) throw badRequest('ต้องระบุ sessionId');

  const [session] = await db
    .select({ id: countSessions.id, mode: countSessions.mode })
    .from(countSessions)
    .where(eq(countSessions.id, sessionId))
    .limit(1);

  if (!session) throw notFound('ไม่พบรอบนับนี้');

  const blind = session.mode === 'blind';

  /**
   * ETag จากโหมด + จำนวนบาร์โค้ด + เวลาที่สินค้าถูกแก้ล่าสุด
   * ถ้า master ไม่เปลี่ยน PDA จะได้ 304 กลับไปโดยไม่ต้องสร้าง payload 2 MB ใหม่
   *
   * ต้องมี mode อยู่ในคีย์ด้วย ไม่งั้นเครื่องที่โหลดตอนรอบเป็น recount แล้วแอดมินสลับกลับเป็น blind
   * จะได้ 304 แล้วใช้ยอดระบบเก่าที่ค้างใน IndexedDB ต่อ — รั่วทั้งที่ตั้งโหมดถูกแล้ว
   */
  const [stat] = await db
    .select({ total: count(), updatedAt: max(products.updatedAt) })
    .from(barcodes)
    .innerJoin(products, eq(products.sku, barcodes.sku));

  const etag = `W/"${sessionId}-${session.mode}-${stat?.total ?? 0}-${stat?.updatedAt?.getTime() ?? 0}"`;

  if (req.headers.get('if-none-match') === etag) {
    return new NextResponse(null, { status: 304, headers: { ETag: etag } });
  }

  const rows = await db
    .select({
      barcode: barcodes.barcode,
      sku: barcodes.sku,
      name: products.name,
      uom: barcodes.uom,
      baseUom: products.baseUom,
      location: products.location,
      factorToBase: uomConversions.factorToBase,
    })
    .from(barcodes)
    .innerJoin(products, eq(products.sku, barcodes.sku))
    .leftJoin(
      uomConversions,
      and(eq(uomConversions.sku, barcodes.sku), eq(uomConversions.uom, barcodes.uom)),
    )
    .where(eq(products.active, true));

  /**
   * ยอดตั้งต้นรวมต่อ SKU **ในหน่วยฐาน**
   *
   * expected_stock เก็บตามหน่วยที่ระบบต้นทางบันทึกไว้ (บางตัวเป็นกล่อง บางตัวเป็นแผง)
   * ผลต่างคิดที่หน่วยฐานเสมอ จึงต้องคูณ factor แล้วรวมต่อ SKU ที่นี่
   * ไม่ใช่ปล่อยให้ PDA เทียบตรงหน่วย — ไม่งั้นยิงบาร์โค้ดคนละหน่วยกับที่ระบบเก็บจะเทียบไม่ได้
   *
   * โหมด blind ข้าม query นี้ทั้งก้อน ยอดระบบจึงไม่เข้ามาใน process ตั้งแต่แรก
   */
  const expectedBySku = new Map<string, number>();

  if (!blind) {
    const expectedRows = await db
      .select({
        sku: expectedStock.sku,
        baseQty: sql<string>`sum(${expectedStock.expectedQty} * coalesce(${uomConversions.factorToBase}, 1))`,
      })
      .from(expectedStock)
      .leftJoin(
        uomConversions,
        and(
          eq(uomConversions.sku, expectedStock.sku),
          eq(uomConversions.uom, expectedStock.uom),
        ),
      )
      .where(eq(expectedStock.sessionId, sessionId))
      .groupBy(expectedStock.sku);

    for (const r of expectedRows) expectedBySku.set(r.sku, Number(r.baseQty));
  }

  /**
   * numeric ของ Postgres มาเป็น string เสมอ — แปลงที่นี่ให้ client ได้ number ล้วน
   *
   * โหมด blind **ไม่ใส่คีย์ expectedBaseQty เลย** ไม่ใช่ใส่เป็น null
   * เพื่อให้ตรวจได้ด้วยการ grep หาชื่อ field ใน response ว่าต้องไม่เจอแม้แต่ตัวเดียว
   * (ฝั่ง PDA แปลง undefined เป็น null ให้ตอนสร้าง index)
   */
  const entries = rows.map((r) => {
    const entry: Record<string, unknown> = {
      barcode: r.barcode,
      sku: r.sku,
      name: r.name,
      uom: r.uom,
      baseUom: r.baseUom,
      factorToBase: r.factorToBase ? Number(r.factorToBase) : 1,
      location: r.location,
    };

    if (!blind) {
      entry.expectedBaseQty = expectedBySku.get(r.sku) ?? null;
    }

    return entry;
  });

  return NextResponse.json(
    { sessionId, mode: session.mode, generatedAt: new Date().toISOString(), entries },
    {
      headers: {
        ETag: etag,
        // ข้อมูล master เปลี่ยนไม่บ่อย แต่ต้องให้เครื่องถามซ้ำทุกครั้ง (ได้ 304 ถ้าไม่เปลี่ยน)
        'Cache-Control': 'private, no-cache',
      },
    },
  );
});
