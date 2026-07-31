/**
 * POST /api/admin/sessions/prepare — เตรียมรอบนับให้พร้อมใช้
 *
 * ทำสองอย่างตามลำดับ (สลับไม่ได้ เพราะ expected_stock มี FK ไป products):
 *   1. sync master data จาก public.products + public.product_master
 *   2. ถ่าย snapshot ยอดตั้งต้นจาก public.stock ของสาขาที่เลือก
 *
 * หลังจากนี้ `snapshot_at` ของรอบนับคือ **cut-off** ที่ผู้ตรวจสอบบัญชีจะอ้างถึง
 */
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { countLines, countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireRole } from '@/server/auth';
import { badRequest, forbidden, notFound, withApi } from '@/server/http';
import { snapshotExpected, syncCatalog } from '@/server/stock/sync';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';
/** sync ทั้ง catalog กับ snapshot ของหมื่น SKU ใช้เวลาหลายสิบวินาที */
export const maxDuration = 300;

const body = z.object({
  sessionId: z.string().uuid(),
  branch: z.string().trim().min(1),
  /** ต้องส่ง true มาถ้าจะถ่าย snapshot ใหม่ทับรอบที่มีคนนับไปแล้ว */
  force: z.boolean().optional(),
});

export const POST = withApi(async (req) => {
  await requireRole(req, 'admin');

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest('ต้องระบุ sessionId และ branch');

  const { sessionId, branch, force } = parsed.data;

  const [session] = await db
    .select({ id: countSessions.id, status: countSessions.status, snapshotAt: countSessions.snapshotAt })
    .from(countSessions)
    .where(eq(countSessions.id, sessionId))
    .limit(1);

  if (!session) throw notFound('ไม่พบรอบนับนี้');
  if (session.status === 'closed') throw forbidden('รอบนับนี้ปิดแล้ว');

  /*
   * ถ่าย snapshot ใหม่ = เลื่อน cut-off ซึ่งทำให้ผลต่างของที่นับไปแล้วเปลี่ยนความหมาย
   * ถ้ามีคนเริ่มนับแล้วต้องยืนยันก่อน
   */
  const [counted] = await db
    .select({ id: countLines.id })
    .from(countLines)
    .where(eq(countLines.sessionId, sessionId))
    .limit(1);

  if (counted && !force) {
    throw forbidden(
      'รอบนี้มีการนับไปแล้ว การถ่ายยอดตั้งต้นใหม่จะเลื่อน cut-off และทำให้ผลต่างที่นับไปแล้วเปลี่ยน ' +
        'ถ้าตั้งใจจริงให้ส่ง force = true',
    );
  }

  const catalog = await syncCatalog();
  const snapshot = await snapshotExpected(sessionId, branch);

  return NextResponse.json({
    catalog,
    snapshot: {
      rows: snapshot.rows,
      snapshotAt: snapshot.snapshotAt.toISOString(),
      skippedUnknownSkus: snapshot.skippedUnknownSkus,
    },
    warning:
      snapshot.skippedUnknownSkus > 0
        ? `มี ${snapshot.skippedUnknownSkus} SKU ที่มียอดในสาขานี้แต่ไม่มีใน master — ยอดตั้งต้นจะไม่ครบ`
        : null,
  });
});
