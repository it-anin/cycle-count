# CLAUDE.md

คู่มือสำหรับ Claude Code เวลาทำงานกับ repo นี้ — อ่านก่อนแก้โค้ด
รายละเอียดการติดตั้ง/ใช้งานอยู่ใน [README.md](README.md) ไฟล์นี้เน้น **โครงสร้าง + กับดัก**

---

## ระบบนี้คืออะไร

ระบบนับสต็อก (cycle count) ของ ANIN — พนักงานคลังใช้เครื่อง PDA (Android) ยิงบาร์โค้ดนับของ
เทียบกับยอดตั้งต้นที่ถ่ายมาจากระบบ POS เดิม แล้วออกรายงานผลต่างให้ผู้ตรวจสอบบัญชี

ขนาดจริง: **~8,200 SKU / ~10,800 บาร์โค้ด** ต่อรอบนับ

ภาษาในโค้ดและคอมเมนต์เป็น**ภาษาไทย** เขียนต่อให้เข้าชุดกัน

---

## ก่อนเพิ่มฟีเจอร์ใหม่ — อ่านข้อนี้ก่อนเสมอ

ระบบนี้ใช้งานจริงโดยพนักงานคลังที่ยืนนับของอยู่หน้าชั้น ไม่ใช่นักพัฒนา
ของที่ใช้อยู่ทุกวันมีค่ามากกว่าของใหม่ที่ยังไม่มีใครขอ

**หลักการ: ฟีเจอร์ใหม่ต้องไม่กระทบ flow การใช้งานเดิม หรือกระทบให้น้อยที่สุด
ถ้ามีผลกระทบ — หยุดแล้วถามก่อนลงมือ**

### สิ่งที่นับว่า "กระทบ flow" — ต้องถามก่อน

- เพิ่ม ย้าย หรือเปลี่ยนความหมายของปุ่มบนหน้าจอนับ
- เพิ่มขั้นตอนก่อนที่พนักงานจะยิงบาร์โค้ดได้ (จอเลือก, ป๊อปอัป, การยืนยัน)
- เปลี่ยนพฤติกรรมของการยิงซ้ำ การแก้จำนวน หรือสิ่งที่เกิดขึ้นหลังกดส่ง
- เปลี่ยนโครงข้อมูลใน `localStorage` / IndexedDB — **ของที่นับค้างไว้ในเครื่องจะอ่านไม่ได้**
  (ถ้าจำเป็นจริงต้องขึ้นเวอร์ชันคีย์ เช่น `cc:ledger:v2:` → `v3:` และวางแผนย้ายข้อมูล)
- เปลี่ยนรูปร่าง response ของ `/api/pda/*` — **APK แจกด้วยมือทีละเครื่อง
  เครื่องที่ยังไม่ได้อัปเดตจะยังยิง endpoint เดิมอยู่** ต้องรองรับของเก่าไปก่อน

### ถ้าฟีเจอร์ใหม่ทำให้ PDA กินแบตเพิ่ม — หยุดและถามทุกครั้ง ไม่มีข้อยกเว้น

เครื่องต้องอยู่ได้ทั้งกะโดยไม่ต้องชาร์จ แบตหมดกลางคลัง = งานนับสะดุดทั้งทีม
รายละเอียดว่าอะไรกินแบตอยู่ที่หัวข้อ [ประหยัดแบตบนเครื่อง PDA](README.md) ใน README

สิ่งที่ถือว่าเพิ่มการใช้แบต:

| | |
|---|---|
| timer / `setInterval` / polling ทุกชนิด | ตอนนี้โค้ดเราไม่มีเลยสักตัว |
| ยิง HTTP ต่อการสแกน หรือเรียก API ถี่ขึ้น | ตอนนี้ radio เงียบสนิทตอนเดินนับ |
| websocket / Supabase realtime | ยังไม่มี — เปิดเมื่อไรคือ radio ตื่นตลอด |
| wake lock / `keepScreenOn` | จอคือตัวกินแบตอันดับหนึ่ง |
| animation / `transition` / อะไรที่ทำให้ repaint ต่อเนื่อง | CSS ตอนนี้ไม่มี `@keyframes` เลย |
| background / foreground service | แอปไม่มีงานเบื้องหลังเลย |
| permission ใหม่ที่ปลุก radio (location, bluetooth) | ตอนนี้มีแค่ `INTERNET` |
| เขียน storage ถี่ขึ้น หรือลด `SAVE_DEBOUNCE_MS` | 800 ms คือค่าที่ชั่งกับความเสี่ยงข้อมูลหายไว้แล้ว |
| งาน render ต่อการสแกนหนักขึ้น หรือทำให้ `memo()` ของแถวใช้ไม่ได้ | ส่ง prop ที่สร้างใหม่ทุก render เข้าแถว = memo พังทันที |
| ใช้กล้องของเครื่องแทนหัวสแกน | กล้อง + decode กินหนักกว่าหัวสแกนมาก |

**วิธีถาม:** บอกว่าฟีเจอร์นี้เพิ่มอะไร ประเมินคร่าว ๆ ว่ากินเพิ่มแค่ไหน
เสนอทางเลือกที่ไม่กินเพิ่ม (ถ้ามี) แล้ว**รอคำตอบก่อนเขียนโค้ด**
อย่าทำไปก่อนแล้วค่อยบอกทีหลัง

---

## โครงสร้าง

```
cycle-count/                    pnpm workspace + Turborepo
├── apps/
│   ├── web/                    Next.js 15 App Router → Vercel (region sin1)
│   └── pda/                    Vite + React 19 + Capacitor 6 → Android APK
└── packages/
    ├── core/                   ตรรกะบริสุทธิ์ + types ที่สองฝั่งใช้ร่วมกัน (มี unit test)
    └── db/                     Drizzle schema + migrations + สคริปต์ CLI
```

### packages/core — ตรรกะกลาง ไม่มี I/O

| ไฟล์ | หน้าที่ |
|---|---|
| `counting.ts` | สมุดบัญชีการนับ — **หนึ่งแถว = หนึ่ง SKU** หน่วยซ้อนอยู่ข้างใน `units[]` |
| `auth.ts` | `authEmailForEmployee()` แปลงรหัสพนักงาน → อีเมลสังเคราะห์ให้ Supabase Auth |
| `pricing.ts` | `resolvePrice()` — หาราคาตาม price list + ช่วงเวลา + หน่วย |
| `importHeaders.ts` | จับคู่หัวคอลัมน์ Excel ไทย/อังกฤษ |
| `schemas.ts` | Zod schema ที่ route handler ใช้ตรวจ payload |

ทุกฟังก์ชันใน `counting.ts` เป็น pure และไม่แปลง array เดิม — คืน array ใหม่เสมอ
มี unit test ครบ รันด้วย `pnpm --filter @cycle-count/core test`

**ทำไมหนึ่งแถวต้องเป็นหนึ่ง SKU:** บาร์โค้ดแต่ละตัวมีตัวคูณของตัวเอง (แผง=1, กล่อง=50)
และผลต่างเทียบกันที่หน่วยฐานเสมอ ถ้าแยกแถวตามหน่วย SKU ที่ยิงทั้งกล่องและแผงจะมีสองแถว
แล้วผลต่างของ SKU นั้นไม่รู้จะโชว์แถวไหน — โชว์ทั้งสองก็ผิด เพราะคนนับจะเข้าใจว่า
แต่ละแถวขาด/เกินเท่านั้นจริง ๆ

### packages/db — schema + สคริปต์

| ไฟล์ | หน้าที่ |
|---|---|
| `schema.ts` | ตารางทั้งหมด **ภายใต้ `pgSchema('cycle_count')`** |
| `external.ts` | ประกาศตารางของระบบเดิมในสถานะอ่านอย่างเดียว — **ห้าม import เข้า schema.ts** |
| `client.ts` | postgres-js + Drizzle ต่อด้วย role `postgres` |
| `uploadBarcodeUnits.ts` | โหลด R05106.CSV → `cycle_count.barcode_units` |
| `createUser.ts` | สร้าง Supabase Auth user + แถว `profiles` พร้อมกัน (รันซ้ำ = เปลี่ยน PIN) |
| `setUserActive.ts` | เปิด/ปิด/ดูรายชื่อบัญชี — แยกจาก createUser เพราะปิดบัญชีไม่ควรต้องกรอกชื่อ+PIN ใหม่ |
| `session.ts` | สร้าง/เปิดใช้/ดูรายการรอบนับ — สร้างเป็น draft เสมอ (ดูเหตุผลข้อ 11) |
| `seed.ts` | ข้อมูลตัวอย่างสำหรับ dev |
| `drizzle/0000_*.sql` | ตารางทั้งหมด (generate) |
| `drizzle/0001_rls.sql` | **เขียนมือ** — เปิด RLS + policy + helper function |

**ตาราง** (ทั้งหมดอยู่ใน `cycle_count`)

```
master     products · barcodes · barcode_units · uom_conversions
pricing    price_lists · prices
ผู้ใช้      profiles
รอบนับ     count_sessions · expected_stock · count_lines
import     import_batches
```

### apps/web — Admin + API

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
│                               + เช็ค profiles.active (ดูข้อ 3 ว่าทำไมต้องเช็คที่นี่)
├── http.ts                     withApi() ครอบ error + CORS, preflight, badRequest/forbidden/notFound
├── counting/report.ts          sessionReport() — ทุก SKU ที่มีคนนับ + counterStats รายคน
├── counting/variance.ts        varianceForSubmission() — เฉพาะ SKU ที่เพิ่งส่ง (ใบเฉลยให้ PDA)
├── stock/sync.ts               syncCatalog() / snapshotExpected() / listBranches()
└── import/upsert.ts            รับ typed rows ล้วน ไม่รู้จัก Excel (รอยต่อ ERP ในอนาคต)
```

**`report.ts` กับ `variance.ts` แยกกันโดยตั้งใจ** — `report.ts` เอาทุก SKU ที่มีคนนับในรอบ
ส่วน `variance.ts` เอาเฉพาะที่เพิ่งส่ง ถ้าเอาทั้งรอบมาเฉลยให้คนนับ อีก 6,600 SKU
ที่ยังไม่มีใครเดินไปนับจะขึ้นว่า "ขาด" ทั้งหมด กลบของจริงจนอ่านไม่ออก

### หน้าเว็บแอดมิน

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
ไม่ใช่บั๊ก ถ้าจะเปลี่ยนเป็น auto-refresh ต้องถามก่อน (มีงานเบื้องหลังเพิ่ม)

### apps/pda — แอปบนเครื่อง

```
src/
├── App.tsx                     สลับ Login ↔ CountLedger
├── screens/LoginScreen.tsx     รหัสพนักงาน + PIN (คีย์แพดของแอปเอง)
├── screens/CountLedgerScreen.tsx   หน้าจอนับ เลย์เอาต์ "สมุดบัญชี" 480×800 แนวตั้ง
└── lib/
    ├── api.ts                  เลือก mock หรือ HTTP จาก VITE_API_BASE_URL + lookup() ค้นในเครื่อง
    ├── supabase.ts             client สำหรับ auth เท่านั้น (ไม่ได้ใช้ query ข้อมูล)
    ├── catalogCache.ts         เก็บ catalog ลง IndexedDB
    ├── useLedger.ts            สมุดบัญชี + persist แบบ debounce + ล็อกกันสแกนซ้ำ
    ├── submittedLog.ts         SKU ที่ส่งสำเร็จแล้วต่อรอบ — append-only กันส่งทับยอดเดิม
    ├── useScanner.ts           รวมสัญญาณจาก native plugin + ช่องพิมพ์เอง
    └── nativeScanner.ts        สะพานไป ScanBroadcastPlugin
```

**SKU ที่ส่งสำเร็จแล้วจะถูกล็อก สแกนซ้ำไม่เข้าสมุดอีก** — กันกับดักทยอยส่ง: สมุดถูกล้างว่าง
หลังส่งทุกครั้ง ถ้าไม่ล็อก ส่ง 5 กล่องแล้วเดินต่อเจออีก 3 แล้วสแกนใหม่ จะ upsert ทับเหลือ 3 ไม่ใช่ 8

เลือกปิดกั้นที่จุดสแกนแทนการเปลี่ยน server ให้บวกเพิ่ม เพราะการบวกจะทำลาย retry-safety เดิม
(ส่งก้อนเดิมซ้ำตอนเน็ตกระตุกต้องยังปลอดภัย เพราะ upsert ทับด้วยค่าเดิม)

```
android/app/src/
├── main/java/co/anin/cyclecount/
│   ├── MainActivity.java           register plugin
│   └── ScanBroadcastPlugin.java    รับ broadcast com.kte.scan.result
└── debug/                          overlay เฉพาะ debug build — เปิด cleartext HTTP ใน LAN
```

---

## คำสั่ง

```bash
pnpm dev                  # web + pda
pnpm build / typecheck / test

pnpm db:generate          # สร้าง migration จาก schema.ts
pnpm db:migrate           # รันขึ้น DB จริง
pnpm db:seed

pnpm --filter @cycle-count/db upload:barcode-units R05106.CSV
pnpm --filter @cycle-count/pda android:apk      # → android/app/build/outputs/apk/debug/

# ผู้ใช้
pnpm --filter @cycle-count/db create:user -- --code MUK --name "มุก" --pin 123456 \
     --warehouse "คลังสินค้า" --role counter        # รันซ้ำด้วยรหัสเดิม = เปลี่ยน PIN
pnpm --filter @cycle-count/db user:active -- --list
pnpm --filter @cycle-count/db user:active -- --code MUK --off

# รอบนับ (หน้าเว็บมีปุ่มทำให้แล้ว CLI ไว้เผื่อ)
pnpm --filter @cycle-count/db session -- --list
pnpm --filter @cycle-count/db session -- --new --code CC-260901-WH \
     --name "นับสต็อก ก.ย. 2569" --branch "คลังสินค้า"
pnpm --filter @cycle-count/db session -- --activate --code CC-260901-WH
```

⚠ **รหัสพนักงานเป็นภาษาไทยไม่ได้** — `authEmailForEmployee()` ตัดทุกอย่างที่ไม่ใช่ `a–z0–9`
แล้ว throw ถ้าไม่เหลืออะไร (`"มุก"` → ค่าว่าง) ส่วน `--name` เป็นไทยได้ปกติ

`.env` อยู่ที่ **root ของ monorepo** ไม่ใช่ในแต่ละ app —
`next.config.mjs`, `vite.config.ts` และ `drizzle.config.ts` ต่างโหลดเองเพราะ
ไม่มี framework ไหนมองขึ้นไปเหนือโฟลเดอร์ตัวเอง

---

## กฎที่ห้ามละเมิด

### 1. ทุกตารางอยู่ใน schema `cycle_count` ไม่ใช่ `public`

โปรเจกต์ Supabase นี้**ใช้ร่วมกับระบบ POS ที่มีข้อมูล production อยู่แล้ว** ใน `public`

- `drizzle.config.ts` ตั้ง `schemaFilter: ['cycle_count']` — **ห้ามเปลี่ยนเป็น `public`**
  ไม่งั้น drizzle-kit จะ generate migration ที่ `DROP` ตารางของระบบเขาทิ้ง
- ทุกบรรทัดใน `0001_rls.sql` ต้อง qualify ด้วย `cycle_count.` เสมอ
- `external.ts` ต้องใช้ `pgTable()` **ไม่ใช่** `pgSchema('public')` (Drizzle throw ตอน runtime
  แล้วทุก route ที่ import `@cycle-count/db` จะ 500 พร้อมกันหมด เพราะ `index.ts` re-export ไฟล์นี้)
- `external.ts` ห้าม import เข้า `schema.ts`

### 2. โหมด blind ต้องบังคับที่ server

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

### 3. RLS ไม่คุ้ม Drizzle

`client.ts` ต่อด้วย role `postgres` ซึ่ง **BYPASSRLS** — policy ใน `0001_rls.sql` เป็นเกราะชั้นสอง
กรณี anon key หลุดเท่านั้น **การตรวจสิทธิ์จริงต้องเรียก `requireUser()` / `requireRole()`
ทุก route** ลืมบรรทัดเดียว = endpoint นั้นเปิดโล่ง

ผลพวงข้อเดียวกัน: **`profiles.active` ต้องเช็คใน `requireUser()` ไม่ใช่ปล่อยให้ RLS จัดการ**
migration มี `cc_is_active_user()` เขียนไว้อยู่แล้ว แต่ policy นั้นไม่เคยทำงานกับ query ที่ผ่านแอปเลย
เคยพลาดตรงนี้มาแล้ว — ปิดบัญชีไปแต่พนักงานยังล็อกอินและส่งผลนับได้ตามปกติ
ถ้าย้ายการเช็คออกจาก `requireUser()` เมื่อไร ช่องโหว่กลับมาทันทีโดยไม่มีอะไรฟ้อง

### 4. ยอดตั้งต้นต้องแช่แข็ง ห้ามอ่านสด

`public.stock` อัปเดตทุก 5 นาที `count_sessions.snapshot_at` คือ **cut-off ของรอบนับ**

ถ้าเปลี่ยนไปอ่านค่าสดตอนคำนวณผลต่าง: ของที่ถูกเบิกไประหว่างนับจะกลายเป็น "ของหาย"
แยกไม่ออกจากของหายจริง และรายงานเดิมจะให้เลขคนละค่าทุกครั้งที่เปิดดู

`prepare` จึงปฏิเสธถ้ารอบนั้นมีคนนับไปแล้ว (ต้องส่ง `force: true`)
และต้อง `syncCatalog()` **ก่อน** `snapshotExpected()` เสมอ เพราะ `expected_stock` มี FK ไป `products`

### 5. ข้อมูลจากระบบเดิมมีสามกับดัก

1. **แถว `__probe__`** — sentinel ของสคริปต์ sync ฝั่งเขา ไม่กรองจะกลายเป็น SKU ปลอมในรอบนับ
2. **`qty` / `multiply` / `cost` เป็น `text`** — `'369.0000'::numeric` ผ่าน แต่เจอ `''` เมื่อไหร่
   ทั้ง statement ล้มและ snapshot ทั้งรอบพัง → ใช้ `numericOrZero()` ที่ guard ด้วย regex ก่อน cast
3. **`branch` มีหลายค่า** — ไม่กรองแล้วยอดตั้งต้นรวมทุกสาขาเข้าด้วยกัน

### 6. ตัวคูณมาจาก R05106 ไม่ใช่ product_master

`product_master.multiply` เก็บได้ **ค่าเดียวต่อ SKU** แต่ของจริงหนึ่ง SKU มีหลายบาร์โค้ดคนละตัวคูณ

```
100098   แผง(1)  10แผง(10)  โหล(12)  กล่อง(50)
100397   ซอง(1)  โหล(12)  กล่อง24(24)  กล่อง(60)
```

`cycle_count.barcode_units` จึงเป็นแหล่งหลัก หน่วยฐาน = หน่วยที่ตัวคูณ = 1

**กับดักของไฟล์นี้: ชื่อสินค้ามี `"` เป็นหน่วยนิ้ว** เช่น `Klean Gauze 2" x 2"` โดยไม่ครอบ quote
CSV parser ที่ตีความ `"` กลางฟิลด์ว่าเปิด quote จะทำให้คอลัมน์เลื่อนทั้งแถวแล้วข้อมูล**หายเงียบ ๆ**
(เจอ 207 จาก 10,841 แถวตอนเทส) — `splitCsvLine()` จึงนับ `"` เป็น quote เฉพาะตอนอยู่ต้นฟิลด์

### 7. เครื่องสแกนเป็น Broadcast Mode เปลี่ยนไม่ได้

PDA ตั้ง `Data Output Mode: Broadcast Mode` (ไม่ใช่ keyboard-wedge) เพราะแอปอื่นบนเครื่องใช้ค่านี้อยู่
บาร์โค้ดมาเป็น Android Intent `com.kte.scan.result` ซึ่ง WebView รับเองไม่ได้

| | ค่า |
|---|---|
| extra ที่มีบาร์โค้ด | **`code`** |
| extra ชนิดบาร์โค้ด | `code_src` — อยู่ใน `IGNORED_KEYS` **ห้ามหยิบมาเป็นบาร์โค้ด** |

สองเรื่องที่แก้พลาดไม่ได้ใน `ScanBroadcastPlugin.java`:

- **register receiver เฉพาะตอนแอปอยู่หน้าจอ** (`handleOnResume` / `handleOnPause`)
  ถ้าประกาศถาวรใน manifest แอปจะรับบาร์โค้ดตอนพนักงานใช้แอปอื่นอยู่ → นับผีเข้ารอบ
- **`ContextCompat.RECEIVER_EXPORTED`** — targetSdk 34 บังคับ ไม่ใส่แล้ว crash ทันทีที่เปิด

**ผลคือเทสการสแกนในเบราว์เซอร์ไม่ได้ ต้อง build APK** (เทสเลย์เอาต์/ปุ่มยังได้ ใช้ปุ่ม "คีย์เอง")

### 8. `authEmailForEmployee()` ต้องเป็นตัวเดียวกันทั้งสองฝั่ง

`EMP-2041` → `emp2041@pda.anin.co.th` หน้าล็อกอินและสคริปต์สร้างผู้ใช้เรียกฟังก์ชันเดียวกัน
**เปลี่ยน `PDA_AUTH_DOMAIN` = ผู้ใช้เดิมทั้งหมดล็อกอินไม่ได้** เพราะ map ไปคนละอีเมล

### 9. ห้าม commit

- `.env` และ `.env.*` ทุกตัว (มี service_role key + รหัส DB)
- `*.CSV` / `*.xlsx` — `R05106.CSV` มีคอลัมน์ราคา `CF_BOTTOMPRICE` / `CF_FMLPRICE` / `CF_TOPPRICE`
  และ `LABELMASTER.xlsx` เป็น master ฉลากยา เป็นไฟล์ import ครั้งเดียว ไม่ใช่ซอร์สโค้ด
- **ห้าม ignore `apps/pda/android/` ทั้งโฟลเดอร์** — ข้างในมีโค้ด native ที่เขียนเอง
  สร้างใหม่จาก `cap add android` ไม่ได้

### 10. เรื่องปลีกย่อยที่เคยกัดมาแล้ว

- **numeric ของ Postgres มาเป็น string เสมอ** — `Number()` ก่อนส่งให้ client ทุกครั้ง
- **Gradle ต้อง 8.7 ขึ้นไป** — Capacitor generate มาเป็น 8.2.1 ซึ่งไม่รองรับ JDK 21
  ลบ `android/` แล้ว `cap add` ใหม่ต้องแก้ `gradle-wrapper.properties` ซ้ำ
- **host `db.<ref>.supabase.co` มีแต่ AAAA record** — เครื่องที่ไม่มี IPv6 ต้องใช้ pooler
  `aws-1-ap-southeast-1.pooler.supabase.com` กับ username `postgres.<ref>`
- **รหัสผ่านที่มี `@` ต้อง percent-encode** เป็น `%40` ใน connection string
- ทุก route handler ประกาศ `export const preferredRegion = 'sin1'` — ปล่อย default
  function จะรันที่ US แล้วคุย DB ที่ Singapore เพิ่ม ~400 ms ต่อ query

### 11. แพตเทิร์นที่ใช้ซ้ำ — เขียนของใหม่ให้เข้าชุด

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

**คีย์ที่เก็บลงเครื่องฝั่ง PDA ต้องมีเวอร์ชันเสมอ** — `cc:ledger:v2:<sessionId>`,
`cc:submitted:v1:<sessionId>`, `cc:scanExtraKey` และต้องอ่านใน `try/catch` แล้วคืนค่าว่างถ้าพัง
(ข้อมูลค้างจากเวอร์ชันเก่าต้องไม่ทำให้จอขาว) — catalog ใช้ IndexedDB แทนเพราะ 2 MB ชน quota

**สคริปต์ CLI ใน `packages/db`** — `process.loadEnvFile()` → `parseArgs()` → **dynamic `import()`**
(ต้องโหลด env ก่อน ไม่งั้น client อ่าน `DATABASE_URL` ไม่เจอ) → ทำงาน → `process.exit(0)`
ทุกตัวรันซ้ำได้ (upsert ไม่ใช่ insert)

### 12. งานที่ย้อนกลับไม่ได้ต้องเตือนก่อน

`close` และ `POST /api/admin/sessions` คืน **409 พร้อม `{ needsConfirm, message, ... }`**
ให้ UI เอารายละเอียดไปแสดง แล้วต้องยิงซ้ำด้วย `force: true` ถึงจะทำจริง

⚠ `prepare` เป็นของเก่ากว่า ใช้ **throw 403** แทน UI แกะรายละเอียดไปแสดงไม่ได้ —
ถ้าแก้ตรงนั้นเมื่อไรให้เปลี่ยนมาเป็นแบบ 409 ให้เหมือนกันทั้งหมด

---

## สถานะการใช้งานจริง

**ใช้งานจริงแล้วตั้งแต่ 5 ส.ค. 2569** — รอบ `CC-260804-WH` (คลังสินค้า, ปิดยอด, 6,696 SKU ตั้งต้น)

เครื่อง PDA 5 เครื่อง: 4 เครื่องเป็นของพนักงานนับ (`MUK` มุก · `LAK` แล็ค · `TANG` ตั๋ง · `PEE` พี)
อีกเครื่องแอดมินใช้ (`ADMIN-01`) — บัญชีทดสอบ `EMP-001/901/902` ถูกปิดไปแล้ว

**แบ่งโซนกันนับ** จึงไม่เกิดปัญหาสอง SKU ทับกัน (ระบบรวมยอดของทุกคนตามการออกแบบ
ถ้านับชั้นซ้ำจะขึ้นเป็น "เกิน" และกันให้ไม่ได้ เพราะยอดตั้งต้นเป็นยอดรวมทั้งคลัง
ไม่มีข้อมูลระดับชั้นวาง)

ทดสอบยิงพร้อมกันทั้ง 4 เครื่องแล้ว — 12 บรรทัดลงครบไม่มี lost update
รวมยอดต่อ SKU ถูกทุกตัว (unique index มี `counted_by` อยู่ในคีย์ คนละคนจึงลงคนละแถว)

---

## บันทึกการพัฒนา

**ต่อกับ Supabase ของจริง**
ระบบเดิมอยู่ใน `public` ของโปรเจกต์เดียวกัน อัปเดตทุก 5 นาที เอามาเป็นยอดตั้งต้นผ่าน snapshot
สำรวจแบบอ่านอย่างเดียวก่อนว่าชื่อไม่ชนกัน แล้วค่อยรัน migration → 11 ตาราง / 19 policy

**บาร์โค้ดเป็นคีย์หลักในการสแกน** SKU เหลือหน้าที่เชื่อมข้อมูลอื่นเท่านั้น
เพิ่มตาราง `barcode_units` และอัปโหลด R05106 เข้าไป 10,841 แถว

**เขียน `counting.ts` ใหม่เป็นหนึ่งแถว = หนึ่ง SKU** ผลต่างคิดที่หน่วยฐานเสมอ
`count_lines` เก็บ `factor_to_base` **ณ เวลาที่นับ** ไม่ใช่อ่านสดจาก `uom_conversions`
เพื่อให้รายงานเก่ายังให้ตัวเลขเดิมหลัง master ถูกแก้

**โหมด blind / recount** บังคับที่ server ตามข้อ 2 ข้างบน

**Broadcast Mode** เขียน Capacitor plugin รับ intent จากเครื่องสแกน + ตั้ง Android SDK / Gradle 8.7

**cleartext HTTP** เพิ่ม `src/debug/` overlay ให้ debug build เรียก API ใน LAN ได้
(Android บล็อก HTTP ธรรมดาตั้งแต่ API 28 — อาการคือล็อกอินผ่านแต่เรียก API ไม่ได้
เพราะ Supabase เป็น https ส่วน API เป็น http)

**ผลการทดสอบบนของจริง** — รัน `prepare` ผ่าน API จริงใช้เวลา 5.2 วินาที

```
8,172 products · 10,841 barcodes · 10,763 uom_conversions
6,696 แถว snapshot · 1 SKU ที่มีของแต่ไม่มีใน master
```

เดินเส้นทาง PDA ครบทั้งเส้นจาก Node: login → session → catalog 1.52 MB (232 KB หลัง gzip)
→ 304 จาก ETag → upsert count-lines ซ้ำได้ผลเท่าเดิม

ตรวจข้อกำหนด "SKU ยอด 0 ต้องสแกนได้": **4,107 SKU ที่ยอดเป็น 0 สแกนได้ทั้งหมด
และไม่มี SKU ไหนที่ไม่มีบาร์โค้ด**

---

## ยังไม่ได้ทำ

- **คอลัมน์มูลค่าผลต่างยังว่าง** — `resolvePrice()` ใน `core/pricing.ts` เขียนเสร็จและมีเทสครบ
  แต่**ไม่มีใครเรียกใช้เลย** `report.ts` เขียน `diffValue: null` ตรง ๆ เหลือแค่ผูก price list เข้ารอบนับ
- **ปลดล็อก SKU ที่ส่งไปแล้ว** — ล็อกอยู่ที่ระดับ SKU ไม่ใช่ระดับหน่วย (ส่ง "กล่อง" แล้วบล็อกทั้ง SKU
  แม้ยังไม่เคยส่ง "แผง") และยังไม่มีปุ่มปลดในหน้าเว็บ ต้องแก้ที่ DB ตรง ๆ
- **ไม่มีเทสอัตโนมัตินอกจาก `packages/core`** (51 ตัว) — `apps/web` กับ `apps/pda`
  ไม่มี test runner ติดตั้งด้วยซ้ำ
- **รวมแพตเทิร์น 403/409 ให้เหลือแบบเดียว** — ดูข้อ 12
- **หน้าเลือกรอบนับบน PDA** — ตอนนี้ยิง `/api/pda/session` แล้วได้รอบ active ล่าสุดมาเลย
- **ผูกรอบทวนกับรอบแรก** (`parentSessionId`) เพื่อให้รอบทวนแสดงว่ารอบแรกนับได้เท่าไร
- **โหมดออฟไลน์เกิน 1 ชั่วโมงยังไม่ได้ทดสอบ** — access token อายุ 3,600 วินาที
  ถ้าปิด Wi-Fi นานกว่านั้นแล้วกดส่ง ยังไม่ยืนยันว่า supabase-js ต่ออายุสำเร็จทุกครั้ง
