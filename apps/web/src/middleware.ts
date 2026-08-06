/**
 * ต่ออายุ session cookie ของ Supabase ทุก request
 *
 * จำเป็นจริง ๆ ไม่ใช่ของเสริม — `lib/supabase/server.ts` เขียนไว้ว่า
 * ถ้า setAll() ถูกเรียกจาก Server Component มันจะเขียน cookie ไม่ได้แล้วปล่อยผ่าน
 * โดยหวังให้ middleware เขียนแทน ถ้าไม่มีไฟล์นี้ access token จะหมดอายุแล้วแอดมิน
 * โดนเด้งออกกลางทางโดยไม่มีสาเหตุที่มองเห็น
 *
 * getClaims() ยืนยันลายเซ็น ES256 ในเครื่องด้วย JWKS ที่ cache ไว้ และยังต่ออายุ
 * token/cookie เมื่อหมดอายุ จึงไม่ต้องรอ network round-trip ไป Auth server ทุก request
 *
 * แปะผลที่ verify แล้วไว้ใน header x-cc-user-id ส่งต่อให้ requireUser() อ่านแทน
 * เพื่อไม่ต้อง verify token ซ้ำอีกรอบที่ route handler / Server Component
 *
 * ต้องตั้งค่า/ลบ header นี้แบบไม่มีเงื่อนไข (ไม่ใช่แค่ตอนมี user) — กัน client
 * ปลอม header เข้ามาเองแล้วหลอกว่าเป็น user คนอื่น ค่าที่ผ่านออกไปจากที่นี่ต้องมาจาก
 * ผล getClaims() ที่ตรวจลายเซ็นแล้วเท่านั้น
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

export async function middleware(request: NextRequest) {
  let cookiesToApply: CookieToSet[] = [];

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          cookiesToApply = cookiesToSet;
        },
      },
    },
  );

  const { data } = await supabase.auth.getClaims();
  const userId = typeof data?.claims?.sub === 'string' ? data.claims.sub : null;

  if (userId) {
    request.headers.set('x-cc-user-id', userId);
  } else {
    request.headers.delete('x-cc-user-id');
  }

  const response = NextResponse.next({ request });
  cookiesToApply.forEach(({ name, value, options }) => response.cookies.set(name, value, options));

  return response;
}

export const config = {
  /*
   * ข้าม static asset กับ /api/pda/* — PDA ส่ง Bearer token ไม่ได้ใช้ cookie
   * ให้ middleware ไปยุ่งด้วยก็เปลืองเวลาต่อ request เปล่า ๆ
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/pda|.*\\.(?:png|jpg|svg|apk)$).*)'],
};
