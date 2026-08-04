/**
 * ต่ออายุ session cookie ของ Supabase ทุก request
 *
 * จำเป็นจริง ๆ ไม่ใช่ของเสริม — `lib/supabase/server.ts` เขียนไว้ว่า
 * ถ้า setAll() ถูกเรียกจาก Server Component มันจะเขียน cookie ไม่ได้แล้วปล่อยผ่าน
 * โดยหวังให้ middleware เขียนแทน ถ้าไม่มีไฟล์นี้ access token จะหมดอายุแล้วแอดมิน
 * โดนเด้งออกกลางทางโดยไม่มีสาเหตุที่มองเห็น
 *
 * getUser() ต้องถูกเรียกที่นี่ ไม่ใช่ getSession() — getUser() คุยกับ Supabase
 * เพื่อยืนยันและต่ออายุจริง ส่วน getSession() แค่อ่าน cookie ที่มีอยู่
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

type CookieToSet = { name: string; value: string; options?: CookieOptions };

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({ request });

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
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  await supabase.auth.getUser();

  return response;
}

export const config = {
  /*
   * ข้าม static asset กับ /api/pda/* — PDA ส่ง Bearer token ไม่ได้ใช้ cookie
   * ให้ middleware ไปยุ่งด้วยก็เปลืองเวลาต่อ request เปล่า ๆ
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/pda|.*\\.(?:png|jpg|svg|apk)$).*)'],
};
