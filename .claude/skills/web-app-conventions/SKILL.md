---
name: web-app-conventions
description: ใช้เมื่อแก้โค้ดใน apps/web (route handler ใต้ src/app/api, server/*, หรือหน้าเว็บแอดมิน) — ตาราง endpoint ทั้ง 12 ตัว, แพตเทิร์น route handler/auth มาตรฐาน, กฎ blind mode, และแพตเทิร์น 403/409
---

# apps/web — Admin + API

**12 route — สิทธิ์ระบุไว้ทุกตัว ห้ามเพิ่ม route ใหม่โดยไม่มีบรรทัด `require*`**

```
src/app/api/
├── health/                     GET   ไม่ตรวจสิทธิ์ — liveness probe ตัวเดียวที่ไม่ห่อ withApi
├── pda/session/                GET   requireUser  { user, session } — หยิบรอบ active ล่าสุด
├── pda/catalog/                GET   requireUser  index บาร์โค้ดทั้งรอบ (ETag/304)
├── pda/count-lines/            POST  requireUser  upsert ผลนับ + ตอบใบเฉลยผลต่างกลับไป
├── admin/branches/             GET   requireRole  รายชื่อสาขาใน public.stock
├── admin/sessions/             GET   requireRole  รายการรอบนับทั้งหมด
│                               POST  requireRole  เปิดรอบใหม่ (สร้าง→snapshot→active ในคำขอเดียว)
├── admin/sessions/prepare/     POST  requireRole  sync catalog + ถ่าย snapshot ของรอบที่มีอยู่
├── admin/sessions/[id]/report/ GET   requireRole  ตารางผลต่างทั้งรอบ + counterStats
├── admin/sessions/[id]/export/ GET   requireRole  ไฟล์ xlsx สองชีต (ผลต่าง + สรุปรายคน)
├── admin/sessions/[id]/close/  POST  requireRole  ปิดรอบ (409 ให้ยืนยันถ้ายังมีคนนับ)
├── import/upload-url/          POST  requireRole  signed URL ให้เบราว์เซอร์อัปตรงเข้า Storage
└── import/process/             POST  requireRole  อ่านไฟล์ที่อัปแล้ว → upsert
```

```
src/middleware.ts               ต่ออายุ session cookie ทุก request — จำเป็นจริง ไม่ใช่ของเสริม
                                (lib/supabase/server.ts เขียนพึ่งไว้ว่าจะมีตัวนี้เขียน cookie แทน
                                 ตอน Server Component เขียนเองไม่ได้ ถ้าไม่มี แอดมินจะโดนเด้งออกกลางทาง)

src/server/
├── auth.ts                     requireUser() / requireRole() — รับ Bearer (PDA) หรือ cookie (เว็บ)
│                               + เช็ค profiles.active (ดูหัวข้อ "RLS ไม่คุ้ม Drizzle" ด้านล่าง)
├── http.ts                     withApi() ครอบ error + CORS, preflight, badRequest/forbidden/notFound
├── counting/report.ts          sessionReport() — ทุก SKU ที่มีคนนับ + counterStats รายคน
├── counting/variance.ts        varianceForSubmission() — เฉพาะ SKU ที่เพิ่งส่ง (ใบเฉลยให้ PDA)
├── stock/sync.ts               syncCatalog() / snapshotExpected() / listBranches()
└── import/upsert.ts            รับ typed rows ล้วน ไม่รู้จัก Excel (รอยต่อ ERP ในอนาคต)
```

**`report.ts` กับ `variance.ts` แยกกันโดยตั้งใจ** — `report.ts` เอาทุก SKU ที่มีคนนับในรอบ
ส่วน `variance.ts` เอาเฉพาะที่เพิ่งส่ง ถ้าเอาทั้งรอบมาเฉลยให้คนนับ อีก 6,600 SKU
ที่ยังไม่มีใครเดินไปนับจะขึ้นว่า "ขาด" ทั้งหมด กลบของจริงจนอ่านไม่ออก

## หน้าเว็บแอดมิน

```
src/app/
├── login/page.tsx              รหัสพนักงาน + PIN ชุดเดียวกับ PDA (authEmailForEmployee ตัวเดียวกัน)
├── page.tsx                    พาไปรอบนับล่าสุดเลย — แอดมินเปิดมาดูรอบที่กำลังนับ 99% ของเวลา
└── sessions/[id]/
    ├── page.tsx                Server Component — ดึง sessionReport() แล้วส่งลงตาราง
    ├── SessionTable.tsx        ตารางผลต่างเต็มจอ + แถบผู้นับ + ปุ่มส่งออก/ปิดรอบ/รีเฟรช
    └── NewSessionDialog.tsx    ฟอร์มเปิดรอบใหม่
```

**เลย์เอาต์เลือกแบบ "ตารางเต็มจอ" (แบบ 8 จาก `design/admin-layouts.html`) มาด้วยเหตุผลเดียว
คือความหนาแน่น** งานหลักของแอดมินคือกวาดตาหาตัวที่ผิดในรายการเป็นร้อย ไม่ใช่อ่านทีละใบ
อย่าเพิ่ม padding หรือการ์ดครอบ มันจะทำลายเหตุผลที่เลือกแบบนี้

**ไม่มี polling / websocket โดยตั้งใจ** — หน้าเป็น Server Component render ครั้งเดียว
ของใหม่จาก PDA จึงไม่ขึ้นเองจนกว่าจะกดปุ่มรีเฟรช (`router.refresh()`) นี่คือพฤติกรรมที่ตั้งใจ
ไม่ใช่บั๊ก ถ้าจะเปลี่ยนเป็น auto-refresh ต้องถามก่อน (มีงานเบื้องหลังเพิ่ม — ดู skill
`feature-impact-check`)

## แพตเทิร์นที่ใช้ซ้ำ — เขียน route ใหม่ให้เข้าชุด

**โครง route handler** — เหมือนกันทุกตัวยกเว้น `/api/health`

```ts
export const dynamic = 'force-dynamic';
export const preferredRegion = 'sin1';
export const OPTIONS = preflight;              // เฉพาะ route ที่ PDA เรียก (คนละ origin)
export const maxDuration = 300;                // เฉพาะตัวที่ sync/snapshot หมื่น SKU

export const GET = withApi(async (req) => {
  await requireRole(req, 'admin');             // หรือ requireUser(req) สำหรับ PDA
  ...
});
```

**อ่าน `[id]` จาก URL ไม่ใช่จาก params** — `withApi()` บีบ signature เหลือ `(req) => Response`
จึงใช้ `new URL(req.url).pathname.split('/').at(-2)!`

## โหมด blind ต้องบังคับที่ server

`count_sessions.mode` มีสองค่า ค่าเริ่มต้น **`blind`** (ผู้ตรวจสอบบัญชีบังคับสำหรับรอบแรก)

การซ่อนใน UI ไม่พอ — catalog ทั้งก้อนอยู่ใน IndexedDB บนเครื่อง เปิด devtools ก็อ่านได้
`/api/pda/catalog` ของรอบ blind จึง**ข้าม query `expected_stock` ทั้งก้อน**
และ**ไม่ใส่คีย์ `expectedBaseQty` ลงใน JSON เลย** (ไม่ใช่ใส่เป็น `null`)

```bash
curl -H "Authorization: Bearer $TOKEN" ".../api/pda/catalog?sessionId=$BLIND" | grep -c expectedBaseQty
# ต้องได้ 0
```

**ETag ต้องมี `mode` อยู่ในคีย์** ไม่งั้นเครื่องที่โหลดตอนรอบเป็น recount แล้วแอดมินสลับกลับเป็น blind
จะได้ 304 แล้วใช้ยอดเก่าที่ค้างในเครื่องต่อ

## RLS ไม่คุ้ม Drizzle

`client.ts` ต่อด้วย role `postgres` ซึ่ง **BYPASSRLS** — policy ใน `0001_rls.sql` เป็นเกราะชั้นสอง
กรณี anon key หลุดเท่านั้น **การตรวจสิทธิ์จริงต้องเรียก `requireUser()` / `requireRole()`
ทุก route** ลืมบรรทัดเดียว = endpoint นั้นเปิดโล่ง

ผลพวงข้อเดียวกัน: **`profiles.active` ต้องเช็คใน `requireUser()` ไม่ใช่ปล่อยให้ RLS จัดการ**
migration มี `cc_is_active_user()` เขียนไว้อยู่แล้ว แต่ policy นั้นไม่เคยทำงานกับ query ที่ผ่านแอปเลย
เคยพลาดตรงนี้มาแล้ว — ปิดบัญชีไปแต่พนักงานยังล็อกอินและส่งผลนับได้ตามปกติ
ถ้าย้ายการเช็คออกจาก `requireUser()` เมื่อไร ช่องโหว่กลับมาทันทีโดยไม่มีอะไรฟ้อง

## งานที่ย้อนกลับไม่ได้ต้องเตือนก่อน

`close` และ `POST /api/admin/sessions` คืน **409 พร้อม `{ needsConfirm, message, ... }`**
ให้ UI เอารายละเอียดไปแสดง แล้วต้องยิงซ้ำด้วย `force: true` ถึงจะทำจริง

⚠ `prepare` เป็นของเก่ากว่า ใช้ **throw 403** แทน UI แกะรายละเอียดไปแสดงไม่ได้ —
ถ้าแก้ตรงนั้นเมื่อไรให้เปลี่ยนมาเป็นแบบ 409 ให้เหมือนกันทั้งหมด

## เรื่องปลีกย่อยที่เคยกัดมาแล้ว

- **numeric ของ Postgres มาเป็น string เสมอ** — `Number()` ก่อนส่งให้ client ทุกครั้ง
- ทุก route handler ประกาศ `export const preferredRegion = 'sin1'` — ปล่อย default
  function จะรันที่ US แล้วคุย DB ที่ Singapore เพิ่ม ~400 ms ต่อ query
