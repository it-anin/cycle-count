/**
 * POST /api/admin/sessions/[id]/close — ปิดรอบนับ
 *
 * ปิดแล้ว `/api/pda/count-lines` จะปฏิเสธทุกการส่งด้วย 403 —
 * **กระทบพนักงานที่กำลังเดินนับอยู่ทันที** ของที่นับค้างในเครื่องจะส่งไม่ได้
 * จึงต้องเตือนก่อนเสมอถ้ายังมีความเคลื่อนไหว แล้วให้แอดมินตัดสินใจเอง
 *
 * รูปแบบ force เดียวกับ /api/admin/sessions/prepare เพื่อให้จำง่าย:
 * ยิงครั้งแรกได้ 409 พร้อมรายละเอียด → ยิงซ้ำด้วย force: true ถึงจะปิดจริง
 */
import { and, eq, gt, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { countLines, countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireRole } from '@/server/auth';
import { badRequest, forbidden, notFound, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

/** ส่งผลมาภายในกี่นาทีถือว่า "ยังนับอยู่" */
const ACTIVE_WINDOW_MIN = 15;

const body = z.object({ force: z.boolean().optional() });

export const POST = withApi(async (req) => {
  await requireRole(req, 'admin');

  const id = new URL(req.url).pathname.split('/').at(-2)!;

  const parsed = body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) throw badRequest('รูปแบบคำขอไม่ถูกต้อง');
  const { force } = parsed.data;

  const [session] = await db
    .select({ id: countSessions.id, code: countSessions.code, status: countSessions.status })
    .from(countSessions)
    .where(eq(countSessions.id, id))
    .limit(1);

  if (!session) throw notFound('ไม่พบรอบนับนี้');
  if (session.status === 'closed') throw forbidden('รอบนับนี้ปิดไปแล้ว');

  const since = new Date(Date.now() - ACTIVE_WINDOW_MIN * 60_000);

  const [recent] = await db
    .select({
      lines: sql<number>`count(*)::int`,
      counters: sql<number>`count(DISTINCT ${countLines.countedBy})::int`,
    })
    .from(countLines)
    .where(and(eq(countLines.sessionId, id), gt(countLines.updatedAt, since)));

  /* SKU ที่มียอดตั้งต้นแต่ยังไม่มีใครเดินไปนับ — ปิดไปตอนนี้ของพวกนี้จะไม่มีข้อมูล */
  const notCountedRows = (await db.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT es.sku FROM cycle_count.expected_stock es
      WHERE es.session_id = ${id}::uuid
      EXCEPT
      SELECT cl.sku FROM cycle_count.count_lines cl
      WHERE cl.session_id = ${id}::uuid AND cl.sku IS NOT NULL
    ) t
  `)) as unknown as { n: number }[];

  const activeLines = Number(recent?.lines ?? 0);
  const activeCounters = Number(recent?.counters ?? 0);
  const pending = Number(notCountedRows[0]?.n ?? 0);

  if (!force && (activeLines > 0 || pending > 0)) {
    return NextResponse.json(
      {
        needsConfirm: true,
        windowMinutes: ACTIVE_WINDOW_MIN,
        activeLines,
        activeCounters,
        notCountedSkus: pending,
        message:
          activeLines > 0
            ? `มี ${activeCounters} เครื่องส่งผลมาใน ${ACTIVE_WINDOW_MIN} นาทีที่ผ่านมา (${activeLines} รายการ)` +
              (pending > 0 ? ` และยังมี ${pending} SKU ที่ยังไม่มีใครนับ` : '')
            : `ยังมี ${pending} SKU ที่มียอดตั้งต้นแต่ยังไม่มีใครนับ`,
      },
      { status: 409 },
    );
  }

  const closedAt = new Date();
  await db
    .update(countSessions)
    .set({ status: 'closed', closedAt })
    .where(eq(countSessions.id, id));

  return NextResponse.json({
    closed: true,
    code: session.code,
    closedAt: closedAt.toISOString(),
    notCountedSkus: pending,
  });
});
