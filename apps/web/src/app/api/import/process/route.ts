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
import { logEvent, logWarn } from '@/server/logging';
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

/**
 * อายุของ lease — เกินนี้ถือว่า lambda ที่จองไว้ตายแล้ว ยึดงานกลับมาได้
 * ตั้งยาวกว่า maxDuration (300 วิ) เท่าตัว เผื่อ cold start และเวลาที่ platform ใช้ฆ่า process
 */
const PROCESSING_LEASE_MS = 600_000;

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
  if (batch.status === 'completed') throw badRequest('รายการนี้ประมวลผลไปแล้ว');

  /*
   * สถานะ `processing` ใช้เป็น lock ไม่ได้ถ้าไม่มีอายุกำกับ
   *
   * lambda ที่ถูกฆ่า (หมด maxDuration / OOM ตอนอ่าน XLSX ใหญ่) จะไม่ได้วิ่งเข้า catch
   * แถวจึงค้างที่ `processing` ตลอดกาล อัปโหลดใหม่ก็ไม่ได้ ต้องแก้ DB ด้วยมือ
   *
   * lease ต้องยาวกว่า maxDuration พอสมควร ไม่งั้นจะไปยึดงานที่ยังทำอยู่จริงมาทำซ้อน
   */
  if (batch.status === 'processing') {
    const startedAt = batch.processingStartedAt?.getTime() ?? 0;
    const heldFor = Date.now() - startedAt;

    if (heldFor < PROCESSING_LEASE_MS) {
      throw badRequest('รายการนี้กำลังประมวลผลอยู่');
    }

    logWarn('import.lease_expired', {
      batchId: batch.id,
      heldForMs: heldFor,
      processedRows: batch.processedRows,
    });
  }

  await db
    .update(importBatches)
    .set({ status: 'processing', processingStartedAt: new Date(), processedRows: 0 })
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

    /*
     * อัปเดตความคืบหน้าทุก batch — ทำให้ไฟล์ที่ล้มกลางทางบอกได้ว่าเขียนไปกี่แถวแล้ว
     * ต่างจากเดิมที่ตั้ง status เป็น failed แต่มีข้อมูลค้างใน DB โดยไม่มีใครรู้ว่าเท่าไร
     */
    const onProgress = async (written: number) => {
      await db
        .update(importBatches)
        .set({ processedRows: written })
        .where(eq(importBatches.id, batch.id));
    };

    if (valid.length > 0) {
      switch (kind) {
        case 'products':
          await upsertProducts(valid as never, onProgress);
          break;
        case 'barcodes':
          await upsertBarcodes(valid as never, onProgress);
          break;
        case 'uom':
          await upsertUomConversions(valid as never, onProgress);
          break;
        case 'prices': {
          const result = await upsertPrices(valid as never, onProgress);
          // ชื่อ price list ที่ไม่มีในระบบ = ตั้งใจพิมพ์ผิด ไม่ควรสร้างให้เงียบ ๆ
          for (const name of result.unknownPriceLists) {
            allErrors.push({ row: 0, message: `ไม่พบ price list ชื่อ "${name}" — แถวที่อ้างถูกข้าม` });
          }
          break;
        }
        case 'expected': {
          if (!batch.sessionId) throw new Error('รายการยอดตั้งต้นนี้ไม่ได้ผูกกับรอบนับ');
          await upsertExpectedStock(batch.sessionId, valid as never, onProgress);
          break;
        }
      }
    }

    await db
      .update(importBatches)
      .set({
        status: 'completed',
        processingStartedAt: null,
        processedRows: valid.length,
        rowCount: valid.length,
        errorCount: allErrors.length,
        errors: allErrors.slice(0, MAX_STORED_ERRORS),
      })
      .where(eq(importBatches.id, batch.id));

    logEvent('import.completed', {
      batchId: batch.id,
      kind,
      imported: valid.length,
      errorCount: allErrors.length,
    });

    return NextResponse.json({
      batchId: batch.id,
      imported: valid.length,
      errorCount: allErrors.length,
      errors: allErrors.slice(0, 20),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'ประมวลผลไฟล์ไม่สำเร็จ';

    /*
     * ปล่อย processed_rows ไว้ตามจริง ไม่รีเซ็ต — แอดมินต้องรู้ว่ามีข้อมูลค้างใน DB กี่แถว
     * ก่อนตัดสินใจว่าจะอัปโหลดซ้ำ (upsert จึงเขียนทับได้ปลอดภัย) หรือย้อนข้อมูลเอง
     */
    await db
      .update(importBatches)
      .set({
        status: 'failed',
        processingStartedAt: null,
        errorCount: 1,
        errors: [{ row: 0, message }],
      })
      .where(eq(importBatches.id, batch.id));

    throw new Error(message);
  }
});
