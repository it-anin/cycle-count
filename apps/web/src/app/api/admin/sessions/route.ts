/**
 * GET /api/admin/sessions — รายการรอบนับทั้งหมด
 *
 * ใช้สองที่: ตัวสลับรอบบนแถบบน และหน้าแรกที่ต้องรู้ว่าจะพาไปรอบไหน
 */
import { desc } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { countSessions } from '@cycle-count/db';

import { db } from '@/lib/db';
import { requireRole } from '@/server/auth';
import { withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

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
