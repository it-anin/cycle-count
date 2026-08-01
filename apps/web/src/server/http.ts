/**
 * ของใช้ร่วมของ Route Handlers — error ที่มี status, ตัวห่อ handler, และ CORS
 *
 * แอป PDA รันคนละ origin กับเว็บ (Capacitor เสิร์ฟจาก https://localhost, dev ที่ :5173)
 * ทุก endpoint ที่ PDA เรียกจึงต้องมี CORS + รองรับ preflight
 */
import { NextResponse } from 'next/server';

import { logRequest, runWithRequestContext } from './logging';

/** โยนจาก handler แล้วให้ withApi() แปลงเป็น response */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const unauthorized = (msg = 'ต้องเข้าสู่ระบบก่อน') => new ApiError(401, msg);
export const forbidden = (msg = 'ไม่มีสิทธิ์ใช้งานส่วนนี้') => new ApiError(403, msg);
export const notFound = (msg = 'ไม่พบข้อมูล') => new ApiError(404, msg);
export const badRequest = (msg: string) => new ApiError(400, msg);

/**
 * origin ที่ยอมให้เรียกข้าม — ตั้งเพิ่มได้ด้วย PDA_ALLOWED_ORIGINS (คั่นด้วย comma)
 * `https://localhost` คือ origin ของ Capacitor WebView บน Android (androidScheme ค่าเริ่มต้น)
 */
function allowedOrigins(): string[] {
  const fromEnv = (process.env.PDA_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  return [...fromEnv, 'https://localhost', 'http://localhost', 'http://localhost:5173'];
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin');
  if (!origin || !allowedOrigins().includes(origin)) return {};

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,if-none-match',
    'Access-Control-Expose-Headers': 'etag',
    Vary: 'Origin',
  };
}

/** ตอบ preflight — export เป็น OPTIONS ในทุก route ที่ PDA เรียก */
export function preflight(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

type Handler = (req: Request) => Promise<Response>;

/**
 * ห่อ handler ให้แปลง ApiError เป็น JSON ที่ client อ่านได้ และแปะ CORS ให้ทุกทาง
 * error ที่ไม่คาดคิดจะไม่ส่งรายละเอียดออกไป แต่ log ไว้ฝั่ง server
 *
 * ทุกคำขอออก log หนึ่งบรรทัดเสมอ ทั้งทางที่สำเร็จและทางที่ล้ม (ดู server/logging.ts)
 * ApiError ถือเป็นผลลัพธ์ปกติ (401/403/404 เกิดได้ตลอด) จึง log เป็น info ไม่ใช่ error
 */
export function withApi(handler: Handler) {
  return async (req: Request): Promise<Response> => {
    const cors = corsHeaders(req);

    return runWithRequestContext(req, async (requestId) => {
      const startedAt = Date.now();
      const path = new URL(req.url).pathname;

      const finish = (res: Response, error?: unknown): Response => {
        logRequest({
          method: req.method,
          path,
          status: res.status,
          durationMs: Date.now() - startedAt,
          error,
        });
        // ให้ client อ้าง id นี้ตอนแจ้งปัญหาได้ โดยไม่ต้องเปิดรายละเอียด error
        res.headers.set('x-request-id', requestId);
        return res;
      };

      try {
        const res = await handler(req);
        for (const [k, v] of Object.entries(cors)) res.headers.set(k, v);
        return finish(res);
      } catch (err) {
        if (err instanceof ApiError) {
          return finish(
            NextResponse.json({ error: err.message }, { status: err.status, headers: cors }),
          );
        }

        return finish(
          NextResponse.json(
            { error: 'เกิดข้อผิดพลาดภายในระบบ' },
            { status: 500, headers: cors },
          ),
          err,
        );
      }
    });
  };
}
