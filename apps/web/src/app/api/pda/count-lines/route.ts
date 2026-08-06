/**
 * POST /api/pda/count-lines — บันทึกผลนับ แล้วเฉลยผลต่างกลับไป
 *
 * upsert ตาม (sessionId, lineKey, countedBy) ไม่ใช่ append
 * PDA ส่งยอดรวมของแถวขึ้นมา ส่งซ้ำกี่ครั้งก็ได้ผลเท่าเดิม — เน็ตกระตุกแล้ว retry ได้ปลอดภัย
 *
 * response มีใบเฉลยผลต่างติดกลับไปด้วย **คำนวณหลังบันทึกเสร็จแล้วเท่านั้น**
 * รอบ blind จึงยังปิดยอดตอนนับได้ตามข้อบังคับ แต่คนนับรู้ทันทีว่าต้องกลับไปนับซ้ำตัวไหน
 */
import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { submitCountBody } from '@cycle-count/core';
import { countLines } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireUser } from '@/server/auth';
import {
  catalogVersion as composeCatalogVersion,
  MASTER_CATALOG_KEY,
} from '@/server/catalog/version';
import { varianceForSubmission } from '@/server/counting/variance';
import { badRequest, forbidden, notFound, preflight, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

export const OPTIONS = preflight;

export const POST = withApi(async (req) => {
  const { userId } = await requireUser(req);

  const parsed = submitCountBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  const { sessionId, catalogVersion: submittedVersion, lines } = parsed.data;

  const now = new Date();

  /**
   * Postgres ไม่ยอมให้ ON CONFLICT DO UPDATE แตะแถวเดิมสองครั้งในคำสั่งเดียว
   * ปกติ PDA ส่ง lineKey ไม่ซ้ำอยู่แล้ว แต่กันไว้ไม่ให้กลายเป็น 500 ที่หาสาเหตุยาก
   */
  const deduped = [...new Map(lines.map((line) => [line.lineKey, line])).values()];

  /*
   * ตรวจ version และ upsert ใน transaction เดียวกัน
   * FOR SHARE ทำให้ master/session writer ต้องรอจนบันทึกเสร็จ จึงไม่มีช่องว่าง
   * แบบ GET ตรวจผ่านแล้ว catalog เปลี่ยนก่อน INSERT
   */
  const outcome = await db.transaction(async (tx) => {
    const masterRows = (await tx.execute(sql`
      SELECT version FROM cycle_count.catalog_state
      WHERE key = ${MASTER_CATALOG_KEY}
      FOR SHARE
    `)) as unknown as { version: string }[];

    const sessionRows = (await tx.execute(sql`
      SELECT status, mode, catalog_version
      FROM cycle_count.count_sessions
      WHERE id = ${sessionId}::uuid
      FOR SHARE
    `)) as unknown as {
      status: 'draft' | 'active' | 'closed';
      mode: 'blind' | 'recount';
      catalog_version: string;
    }[];

    const session = sessionRows[0];
    if (!session) throw notFound('ไม่พบรอบนับนี้');
    if (session.status !== 'active') throw forbidden('รอบนับนี้ปิดแล้ว บันทึกเพิ่มไม่ได้');

    const master = masterRows[0];
    if (!master) throw new Error('ยังไม่ได้ตั้งค่า catalog_state:master');

    const currentVersion = composeCatalogVersion(
      master.version,
      session.catalog_version,
      session.mode,
    );

    /* APK เก่าไม่มี field นี้ — รับต่อแบบ legacy จนกว่าจะแจก APK ใหม่ครบ */
    if (submittedVersion && submittedVersion !== currentVersion) {
      return { kind: 'stale' as const, currentVersion };
    }

    const saved = await tx
      .insert(countLines)
      .values(
        deduped.map((line) => ({
          sessionId,
          lineKey: line.lineKey,
          // แถวที่ไม่พบใน master เก็บ sku เป็น null แล้ว flag ไว้ให้แอดมินตาม
          sku: line.flagged ? null : line.sku,
          uom: line.uom,
          factorToBase: String(line.factorToBase),
          scannedBarcode: line.scannedBarcode,
          countedQty: String(line.countedQty),
          flagged: line.flagged,
          countedBy: userId,
          countedAt: new Date(line.countedAt),
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [countLines.sessionId, countLines.lineKey, countLines.countedBy],
        set: {
          countedQty: sql`excluded.counted_qty`,
          factorToBase: sql`excluded.factor_to_base`,
          scannedBarcode: sql`excluded.scanned_barcode`,
          flagged: sql`excluded.flagged`,
          countedAt: sql`excluded.counted_at`,
          updatedAt: now,
        },
      })
      .returning({ id: countLines.id });

    return { kind: 'saved' as const, saved };
  });

  if (outcome.kind === 'stale') {
    return NextResponse.json(
      {
        code: 'CATALOG_STALE',
        error: 'รายการสินค้าในระบบมีการอัปเดต กรุณาตรวจสอบก่อนส่งอีกครั้ง',
        currentVersion: outcome.currentVersion,
      },
      { status: 409 },
    );
  }

  const { saved } = outcome;

  /*
   * เฉลยผลต่างหลังบันทึกแล้ว — ลำดับสำคัญ ถ้าคำนวณก่อน upsert จะได้ยอดของรอบก่อนหน้า
   *
   * นับ unknown จากสิ่งที่เพิ่งส่งขึ้นมา ไม่ใช่ทั้งรอบ เพราะเป็นคำตอบให้คนที่กดส่งตอนนี้
   * ว่า "ของที่เพิ่งยิงไปมีกี่ตัวที่ระบบไม่รู้จัก"
   */
  const skus = [...new Set(deduped.filter((l) => !l.flagged && l.sku).map((l) => l.sku!))];
  const unknownCount = new Set(deduped.filter((l) => l.flagged).map((l) => l.lineKey)).size;
  const variance = await varianceForSubmission(sessionId, skus, unknownCount);

  return NextResponse.json({ saved: saved.length, variance });
});
