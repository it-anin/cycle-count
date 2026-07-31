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

  const [batch] = await db
    .insert(importBatches)
    .values({
      type,
      sessionId: sessionId ?? null,
      filename,
      status: 'pending',
      createdBy: userId,
    })
    .returning({ id: importBatches.id });

  // ตั้งชื่อไฟล์ตาม batch id — ไม่ชนกันและตามรอยกลับไปหาแถวใน import_batches ได้
  const storagePath = `${type}/${batch!.id}.xlsx`;

  const { data, error } = await createAdminClient()
    .storage.from(IMPORT_BUCKET)
    .createSignedUploadUrl(storagePath);

  if (error) throw new Error(`ขอ URL อัปโหลดไม่สำเร็จ: ${error.message}`);

  await db
    .update(importBatches)
    .set({ storagePath })
    .where(eq(importBatches.id, batch!.id));

  return NextResponse.json({
    batchId: batch!.id,
    bucket: IMPORT_BUCKET,
    path: storagePath,
    token: data.token,
  });
});
