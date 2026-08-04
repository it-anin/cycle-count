/**
 * GET  /api/admin/sessions — รายการรอบนับทั้งหมด
 * POST /api/admin/sessions — เปิดรอบนับใหม่ (สร้าง → ถ่ายยอดตั้งต้น → เปิดใช้)
 */
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { countLines, countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireRole } from '@/server/auth';
import { badRequest, withApi } from '@/server/http';
import { snapshotExpected, syncCatalog } from '@/server/stock/sync';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';
/** sync catalog + snapshot หมื่น SKU ใช้เวลาหลายวินาที */
export const maxDuration = 300;

export const GET = withApi(async (req) => {
  await requireRole(req, 'admin');

  const rows = await db
    .select({
      id: countSessions.id,
      code: countSessions.code,
      name: countSessions.name,
      mode: countSessions.mode,
      status: countSessions.status,
      sourceBranch: countSessions.sourceBranch,
      snapshotAt: countSessions.snapshotAt,
      createdAt: countSessions.createdAt,
    })
    .from(countSessions)
    .orderBy(desc(countSessions.createdAt));

  return NextResponse.json({ sessions: rows });
});

/** ส่งผลมาภายในกี่นาทีถือว่า "ยังนับอยู่" — ตรงกับเกณฑ์ตอนปิดรอบ */
const ACTIVE_WINDOW_MIN = 15;

const createBody = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(120),
  branch: z.string().trim().min(1),
  mode: z.enum(['blind', 'recount']).default('blind'),
  /** ปิดรอบที่เปิดค้างอยู่ให้ด้วย — ไม่งั้นจะมีสองรอบขึ้นว่าเปิดพร้อมกัน */
  closePrevious: z.boolean().default(true),
  force: z.boolean().default(false),
});

/**
 * เปิดรอบนับใหม่ — ทำสามอย่างต่อกันเพราะแยกกันแล้วไม่มีประโยชน์
 *
 *   1. สร้างรอบเป็น draft
 *   2. sync catalog + ถ่าย snapshot ยอดตั้งต้น  ← ใช้เวลาหลายวินาที
 *   3. เปลี่ยนเป็น active
 *
 * **ลำดับสำคัญ** ถ้าเปิดใช้ก่อนถ่ายยอด เครื่อง PDA จะกระโดดเข้ารอบใหม่ทันที
 * (`/api/pda/session` หยิบรอบ active ล่าสุดให้เอง) แล้วทุก SKU กลายเป็น "ไม่มียอดตั้งต้น"
 *
 * ถ้าพังตอนขั้นที่ 2 รอบจะค้างเป็น draft ซึ่งปลอดภัย — เครื่อง PDA มองไม่เห็น
 * แก้ได้ด้วยการเรียก /api/admin/sessions/prepare ซ้ำ
 */
export const POST = withApi(async (req) => {
  await requireRole(req, 'admin');

  const parsed = createBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    throw badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { code, name, branch, mode, closePrevious, force } = parsed.data;

  const [dup] = await db
    .select({ id: countSessions.id, status: countSessions.status })
    .from(countSessions)
    .where(eq(countSessions.code, code))
    .limit(1);
  if (dup) throw badRequest(`รหัส ${code} ถูกใช้ไปแล้ว (สถานะ ${dup.status})`);

  /*
   * เตือนก่อนถ้ายังมีคนนับอยู่ในรอบเดิม
   *
   * เปิดรอบใหม่ = เครื่อง PDA ทุกเครื่องย้ายไปรอบใหม่ในการเรียกครั้งถัดไป
   * ของที่นับค้างในเครื่องแต่ยังไม่ได้กดส่งจะเข้าไม่ถึงอีก (สมุดผูกกับ session id)
   */
  /*
   * เรียงใหม่สุดก่อน เพราะรอบที่เครื่อง PDA ใช้อยู่คือรอบ active ที่ createdAt ล่าสุด
   * (ดู /api/pda/session) — ถ้ามีหลายรอบเปิดค้าง ต้องรายงานรอบนั้นเป็นตัวแทน
   */
  const active = await db
    .select({ id: countSessions.id, code: countSessions.code })
    .from(countSessions)
    .where(eq(countSessions.status, 'active'))
    .orderBy(desc(countSessions.createdAt));

  if (!force && active.length > 0) {
    const since = new Date(Date.now() - ACTIVE_WINDOW_MIN * 60_000);

    /*
     * ต้องดูทุกรอบที่เปิดค้าง ไม่ใช่แค่รอบเดียว
     * เคยพลาดตรงนี้มาแล้ว: เช็คแค่ตัวแรกในลิสต์ที่ไม่ได้เรียงลำดับ พอมีสองรอบเปิดพร้อมกัน
     * มันไปเช็ครอบที่ไม่มีใครนับ แล้วปล่อยให้เปิดรอบใหม่ทับคนที่กำลังนับอยู่เงียบ ๆ
     */
    const [recent] = await db
      .select({
        lines: sql<number>`count(*)::int`,
        counters: sql<number>`count(DISTINCT ${countLines.countedBy})::int`,
      })
      .from(countLines)
      .where(
        and(
          inArray(
            countLines.sessionId,
            active.map((s) => s.id),
          ),
          gt(countLines.updatedAt, since),
        ),
      );

    if (Number(recent?.lines ?? 0) > 0) {
      return NextResponse.json(
        {
          needsConfirm: true,
          openSessionCode: active[0]!.code,
          activeLines: Number(recent!.lines),
          activeCounters: Number(recent!.counters),
          windowMinutes: ACTIVE_WINDOW_MIN,
          message:
            `รอบ ${active[0]!.code} ยังมี ${recent!.counters} เครื่องส่งผลมาใน ` +
            `${ACTIVE_WINDOW_MIN} นาทีที่ผ่านมา (${recent!.lines} รายการ)`,
        },
        { status: 409 },
      );
    }
  }

  const [created] = await db
    .insert(countSessions)
    .values({ code, name, mode, status: 'draft', sourceBranch: branch, location: branch })
    .returning({ id: countSessions.id });

  const sessionId = created!.id;
  const catalog = await syncCatalog();
  const snapshot = await snapshotExpected(sessionId, branch);

  if (closePrevious && active.length > 0) {
    const closedAt = new Date();
    for (const s of active) {
      await db
        .update(countSessions)
        .set({ status: 'closed', closedAt })
        .where(eq(countSessions.id, s.id));
    }
  }

  await db.update(countSessions).set({ status: 'active' }).where(eq(countSessions.id, sessionId));

  return NextResponse.json({
    id: sessionId,
    code,
    catalog,
    snapshot: {
      rows: snapshot.rows,
      snapshotAt: snapshot.snapshotAt.toISOString(),
      skippedUnknownSkus: snapshot.skippedUnknownSkus,
    },
    closedSessions: closePrevious ? active.map((s) => s.code) : [],
    warning:
      snapshot.skippedUnknownSkus > 0
        ? `มี ${snapshot.skippedUnknownSkus} SKU ที่มียอดในสาขานี้แต่ไม่มีใน master — ยอดตั้งต้นจะไม่ครบ`
        : null,
  });
});
