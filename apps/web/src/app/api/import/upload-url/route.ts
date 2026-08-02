/**
 * POST /api/import/upload-url — ขอ URL สำหรับอัปโหลดไฟล์ Excel
 *
 * เบราว์เซอร์อัปโหลดไฟล์ **ตรงเข้า Supabase Storage** ไม่ผ่าน route handler
 * เพราะ Vercel จำกัด request body ที่ 4.5 MB ซึ่งไฟล์ master หมื่นแถวชนได้ง่าย
 * และการสตรีมไฟล์ผ่าน function ก็เปลืองเวลาทำงานโดยไม่จำเป็น
 *
 * คืน path + token ให้ client เรียก supabase.storage.uploadToSignedUrl()
 * แล้วค่อยเรียก /api/import/process ด้วย batchId ที่ได้
 */
import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { importBatches } from '@cycle-count/db';

import { db } from '@/lib/db';
import { createAdminClient, IMPORT_BUCKET } from '@/lib/supabase/admin';
import { requireRole } from '@/server/auth';
import { badRequest, withApi } from '@/server/http';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';

const body = z.object({
  type: z.enum(['products', 'barcodes', 'uom', 'prices', 'expected']),
  filename: z.string().trim().min(1).max(255),
  /** ต้องมีเมื่อ type = 'expected' */
  sessionId: z.string().uuid().optional(),
});

export const POST = withApi(async (req) => {
  const { userId } = await requireRole(req, 'admin');

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest('ข้อมูลคำขอไม่ถูกต้อง');

  const { type, filename, sessionId } = parsed.data;
  if (type === 'expected' && !sessionId) {
    throw badRequest('การนำเข้ายอดตั้งต้นต้องระบุรอบนับ');
  }

  /*
   * path คำนวณจาก id ที่ DB สร้างให้ จึงต้อง INSERT ก่อนถึงจะรู้ path
   * แต่ path เป็นสูตรตายตัว (`<type>/<id>.xlsx`) จึงเขียน storage_path ลงไปได้
   * ตั้งแต่ INSERT แรกเลย ไม่ต้อง UPDATE ตามทีหลัง — เหลือสองสเต็ปแทนสาม
   */
  const batchId = randomUUID();
  const storagePath = `${type}/${batchId}.xlsx`;

  await db.insert(importBatches).values({
    id: batchId,
    type,
    sessionId: sessionId ?? null,
    filename,
    storagePath,
    status: 'pending',
    createdBy: userId,
  });

  const { data, error } = await createAdminClient()
    .storage.from(IMPORT_BUCKET)
    .createSignedUploadUrl(storagePath);

  /*
   * ขอ URL ไม่ผ่าน = แถวที่เพิ่ง INSERT จะกลายเป็นขยะที่ไม่มีวันถูกใช้
   * ลบทิ้งทันทีแทนที่จะปล่อยค้างให้หน้าประวัติรก (ลบไม่ผ่านก็ไม่เป็นไร
   * เพราะสถานะยังเป็น pending ซึ่งกวาดทีหลังได้)
   */
  if (error) {
    await db.delete(importBatches).where(eq(importBatches.id, batchId));
    throw new Error(`ขอ URL อัปโหลดไม่สำเร็จ: ${error.message}`);
  }

  return NextResponse.json({
    batchId,
    bucket: IMPORT_BUCKET,
    path: storagePath,
    token: data.token,
  });
});
