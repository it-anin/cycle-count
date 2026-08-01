/**
 * log แบบมีโครงสร้าง — หนึ่งบรรทัด JSON ต่อหนึ่งคำขอ
 *
 * ก่อนหน้านี้ทั้งแอปมี `console.error` อยู่บรรทัดเดียว เวลามีปัญหาหน้างานจึงตอบไม่ได้ว่า
 * ใครเรียก เรียกอะไร ตอนไหน ใช้เวลาเท่าไร — โดยเฉพาะ `prepare` ที่ใช้เวลาหลายสิบวินาที
 * และไปแตะข้อมูล production ของระบบ POS
 *
 * ออกทาง stdout เป็น JSON เพราะ Vercel เก็บ log บรรทัดต่อบรรทัดอยู่แล้ว
 * และ JSON ทำให้ค้นด้วย field ได้โดยไม่ต้องต่อ log aggregator
 *
 * **userId มาทีหลัง path** — ตอนเริ่มคำขอยังไม่รู้ว่าใคร ต้องรอ `requireUser()` ตรวจ token เสร็จก่อน
 * จึงใช้ AsyncLocalStorage ให้ `requireUser()` เติมค่าเข้ามาในบริบทของคำขอนั้นได้
 * โดยไม่ต้องส่ง context ผ่านทุก signature (route handler ของ Next รับแค่ Request)
 */
import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
  requestId: string;
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** id ของคำขอ — ใช้ของ Vercel ถ้ามี จะได้ผูกกับ log ของ platform ได้ */
function requestIdFrom(req: Request): string {
  return (
    req.headers.get('x-vercel-id') ??
    req.headers.get('x-request-id') ??
    globalThis.crypto.randomUUID()
  );
}

/** ครอบการทำงานของหนึ่งคำขอ เพื่อให้ setLogUser() หา context เจอ */
export function runWithRequestContext<T>(req: Request, fn: (requestId: string) => T): T {
  const ctx: RequestContext = { requestId: requestIdFrom(req) };
  return storage.run(ctx, () => fn(ctx.requestId));
}

/**
 * บันทึกว่าคำขอนี้เป็นของใคร — เรียกจาก requireUser() หลังตรวจ token ผ่าน
 * ถ้าเรียกนอกบริบทคำขอ (เช่นในเทส) จะไม่ทำอะไร ไม่ throw
 */
export function setLogUser(userId: string): void {
  const ctx = storage.getStore();
  if (ctx) ctx.userId = userId;
}

export function currentRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** ค่าที่ throw ออกมาไม่จำเป็นต้องเป็น Error — แปลงให้อ่านได้โดยไม่ throw ซ้ำ */
function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

type Level = 'info' | 'warn' | 'error';

function emit(level: Level, fields: Record<string, unknown>): void {
  const ctx = storage.getStore();
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    requestId: ctx?.requestId,
    userId: ctx?.userId,
    ...fields,
  });

  if (level === 'error') console.error(line);
  else console.log(line);
}

/** เหตุการณ์ระหว่างทาง เช่นแต่ละสเต็ปของ prepare */
export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  emit('info', { event, ...fields });
}

export function logWarn(event: string, fields: Record<string, unknown> = {}): void {
  emit('warn', { event, ...fields });
}

/**
 * สรุปหนึ่งคำขอ — เรียกจาก withApi() ทั้งทางที่สำเร็จและทางที่ error
 *
 * ไม่ log ตัว error object ทั้งก้อนเพราะอาจมี connection string หรือ query ที่มีข้อมูลจริงติดมา
 * เก็บแค่ชื่อกับข้อความ ส่วน stack เก็บเฉพาะ error ที่ไม่คาดคิด
 */
export function logRequest(fields: {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  error?: unknown;
}): void {
  const { error, ...rest } = fields;

  if (error === undefined) {
    emit('info', { event: 'request', ...rest });
    return;
  }

  emit('error', {
    event: 'request',
    ...rest,
    errorName: error instanceof Error ? error.name : typeof error,
    // ค่าที่ไม่ใช่ Error อาจเป็น object ที่ String() แล้วได้ '[object Object]' — ใช้ JSON แทน
    errorMessage: error instanceof Error ? error.message : safeStringify(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
}
