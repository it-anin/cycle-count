/**
 * GET /api/pda/catalog?sessionId=... — index บาร์โค้ดทั้งรอบนับ
 *
 * PDA โหลดก้อนนี้ครั้งเดียวตอนเปิดรอบ แล้วค้นในเครื่อง ไม่มี HTTP ต่อการสแกน
 * ETag มาจาก version ที่หมุนใน transaction เดียวกับ master write จึงตรวจเจอทั้ง
 * การย้ายบาร์โค้ดและการแก้ตัวคูณ แม้จำนวนแถวไม่เปลี่ยน
 */
import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import {
  barcodes,
  catalogState,
  countSessions,
  expectedStock,
  products,
  uomConversions,
} from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireUser } from '@/server/auth';
import {
  catalogVersion as composeCatalogVersion,
  MASTER_CATALOG_KEY,
} from '@/server/catalog/version';
import { badRequest, notFound, preflight, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export const OPTIONS = preflight;

export const GET = withApi(async (req) => {
  await requireUser(req);

  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) throw badRequest('ต้องระบุ sessionId');

  /*
   * repeatable read ทำให้ version และ rows เป็น snapshot เดียวกันเสมอ:
   * ได้ข้อมูลชุดก่อน master commit ทั้งก้อน หรือชุดหลัง commit ทั้งก้อน
   */
  const result = await db.transaction(
    async (tx) => {
      const [session] = await tx
        .select({
          id: countSessions.id,
          mode: countSessions.mode,
          catalogVersion: countSessions.catalogVersion,
        })
        .from(countSessions)
        .where(eq(countSessions.id, sessionId))
        .limit(1);

      if (!session) throw notFound('ไม่พบรอบนับนี้');

      const [master] = await tx
        .select({ version: catalogState.version })
        .from(catalogState)
        .where(eq(catalogState.key, MASTER_CATALOG_KEY))
        .limit(1);

      if (!master) throw new Error('ยังไม่ได้ตั้งค่า catalog_state:master');

      const version = composeCatalogVersion(master.version, session.catalogVersion, session.mode);
      const etag = `W/"${version}"`;

      if (req.headers.get('if-none-match') === etag) {
        return { notModified: true as const, etag };
      }

      const rows = await tx
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

      /* รอบ blind ห้าม query expected_stock และห้ามใส่ field นี้ใน JSON */
      const expectedBySku = new Map<string, number>();
      if (session.mode !== 'blind') {
        const expectedRows = await tx
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

        for (const row of expectedRows) expectedBySku.set(row.sku, Number(row.baseQty));
      }

      const entries = rows.map((row) => {
        const entry: Record<string, unknown> = {
          barcode: row.barcode,
          sku: row.sku,
          name: row.name,
          uom: row.uom,
          baseUom: row.baseUom,
          factorToBase: row.factorToBase ? Number(row.factorToBase) : 1,
          location: row.location,
        };

        if (session.mode !== 'blind') {
          entry.expectedBaseQty = expectedBySku.get(row.sku) ?? null;
        }

        return entry;
      });

      return {
        notModified: false as const,
        etag,
        body: {
          sessionId,
          mode: session.mode,
          catalogVersion: version,
          generatedAt: new Date().toISOString(),
          entries,
        },
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );

  if (result.notModified) {
    return new NextResponse(null, { status: 304, headers: { ETag: result.etag } });
  }

  return NextResponse.json(result.body, {
    headers: {
      ETag: result.etag,
      'Cache-Control': 'private, no-cache',
    },
  });
});
