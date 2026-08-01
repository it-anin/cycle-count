/**
 * POST /api/import/process — อ่านไฟล์ที่อัปโหลดแล้ว validate แล้วเขียนลง DB
 *
 * เรียกต่อจาก /api/import/upload-url หลังอัปโหลดไฟล์เข้า Storage เสร็จ
 * หน้าเว็บ poll สถานะจากตาราง import_batches (มี status / rowCount / errorCount / errors ครบอยู่แล้ว)
 *
 * เก็บ error ไว้ 200 แถวแรกพอ — ไฟล์ที่ผิดเป็นพันแถวแปลว่ากรอกผิดคอลัมน์
 * ผู้ใช้ต้องแก้ไฟล์แล้วอัปใหม่อยู่ดี ไม่ต้องยัด jsonb ให้บวม
 */
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { z } from 'zod';

import {
  missingRequiredHeaders,
  normalizeRows,
  parseRows,
  type ParsedRowError,
} from '@cycle-count/core';
import { importBatches } from '@cycle-count/db';

import { db } from '@/lib/db';
import { createAdminClient, IMPORT_BUCKET } from '@/lib/supabase/admin';
import { requireRole } from '@/server/auth';
import { badRequest, notFound, withApi } from '@/server/http';
import {
  upsertBarcodes,
  upsertExpectedStock,
  upsertPrices,
  upsertProducts,
  upsertUomConversions,
} from '@/server/import/upsert';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';
/** ไฟล์หมื่นแถวใช้เวลาหลายสิบวินาที — ต้องใช้แผน Vercel ที่ให้ maxDuration ระดับนี้ */
export const maxDuration = 300;

const MAX_STORED_ERRORS = 200;

const body = z.object({ batchId: z.string().uuid() });

export const POST = withApi(async (req) => {
  await requireRole(req, 'admin');

  const parsed = body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) throw badRequest('ต้องระบุ batchId');

  const [batch] = await db
    .select()
    .from(importBatches)
    .where(eq(importBatches.id, parsed.data.batchId))
    .limit(1);

  if (!batch) throw notFound('ไม่พบรายการนำเข้านี้');
  if (!batch.storagePath) throw badRequest('รายการนี้ยังไม่มีไฟล์ที่อัปโหลด');
  if (batch.status === 'processing') throw badRequest('รายการนี้กำลังประมวลผลอยู่');
  if (batch.status === 'completed') throw badRequest('รายการนี้ประมวลผลไปแล้ว');

  await db
    .update(importBatches)
    .set({ status: 'processing' })
    .where(eq(importBatches.id, batch.id));

  try {
    const { data, error } = await createAdminClient()
      .storage.from(IMPORT_BUCKET)
      .download(batch.storagePath);

    if (error || !data) throw new Error(`อ่านไฟล์จาก Storage ไม่ได้: ${error?.message ?? 'ไม่พบไฟล์'}`);

    const workbook = XLSX.read(await data.arrayBuffer(), { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new Error('ไฟล์นี้ไม่มีชีตข้อมูล');

    const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[sheetName]!, {
      defval: undefined,
    });

    if (raw.length === 0) throw new Error('ชีตแรกของไฟล์ไม่มีข้อมูล');

    const kind = batch.type;
    const missing = missingRequiredHeaders(kind, Object.keys(raw[0]!));
    if (missing.length > 0) {
      throw new Error(`ไฟล์ขาดคอลัมน์ที่จำเป็น: ${missing.join(', ')}`);
    }

    const { valid, errors } = parseRows(kind, normalizeRows(kind, raw));
    const allErrors: ParsedRowError[] = [...errors];

    if (valid.length > 0) {
      switch (kind) {
        case 'products':
          await upsertProducts(valid as never);
          break;
        case 'barcodes':
          await upsertBarcodes(valid as never);
          break;
        case 'uom':
          await upsertUomConversions(valid as never);
          break;
        case 'prices': {
          const result = await upsertPrices(valid as never);
          // ชื่อ price list ที่ไม่มีในระบบ = ตั้งใจพิมพ์ผิด ไม่ควรสร้างให้เงียบ ๆ
          for (const name of result.unknownPriceLists) {
            allErrors.push({ row: 0, message: `ไม่พบ price list ชื่อ "${name}" — แถวที่อ้างถูกข้าม` });
          }
          break;
        }
        case 'expected': {
          if (!batch.sessionId) throw new Error('รายการยอดตั้งต้นนี้ไม่ได้ผูกกับรอบนับ');
          await upsertExpectedStock(batch.sessionId, valid as never);
          break;
        }
      }
    }

    await db
      .update(importBatches)
      .set({
        status: 'completed',
        rowCount: valid.length,
        errorCount: allErrors.length,
        errors: allErrors.slice(0, MAX_STORED_ERRORS),
      })
      .where(eq(importBatches.id, batch.id));

    return NextResponse.json({
      batchId: batch.id,
      imported: valid.length,
      errorCount: allErrors.length,
      errors: allErrors.slice(0, 20),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ประมวลผลไฟล์ไม่สำเร็จ';

    await db
      .update(importBatches)
      .set({ status: 'failed', errorCount: 1, errors: [{ row: 0, message }] })
      .where(eq(importBatches.id, batch.id));

    throw new Error(message);
  }
});
