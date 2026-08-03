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

```
src/app/api/
├── health/                     GET   ทดสอบว่าเครื่องเข้าถึงได้
├── pda/session/                GET   { user, session }
├── pda/catalog/                GET   index บาร์โค้ดทั้งรอบ (ETag/304)
├── pda/count-lines/            POST  upsert ผลนับ กันซ้ำด้วย lineKey
├── admin/branches/             GET   รายชื่อสาขาใน public.stock
├── admin/sessions/prepare/     POST  sync catalog + ถ่าย snapshot
├── import/upload-url/          POST  signed URL ให้เบราว์เซอร์อัปตรงเข้า Storage
└── import/process/             POST  อ่านไฟล์ที่อัปแล้ว → upsert
```

```
src/server/
├── auth.ts                     requireUser() / requireRole() — รับ Bearer (PDA) หรือ cookie (เว็บ)
├── http.ts                     withApi() ครอบ error + CORS, preflight
├── stock/sync.ts               syncCatalog() / snapshotExpected() / listBranches()
└── import/upsert.ts            รับ typed rows ล้วน ไม่รู้จัก Excel (รอยต่อ ERP ในอนาคต)
```

**หน้าเว็บยังไม่มี** — `page.tsx` เป็นหน้า placeholder ที่ลิงก์ไป `/api/health` เท่านั้น
API พร้อมหมดแล้วแต่ยังไม่มี UI เรียก

### apps/pda — แอปบนเครื่อง

```
src/
├── App.tsx                     สลับ Login ↔ CountLedger
├── screens/LoginScreen.tsx     รหัสพนักงาน + PIN (คีย์แพดของแอปเอง)
├── screens/CountLedgerScreen.tsx   หน้าจอนับ เลย์เอาต์ "สมุดบัญชี" 480×800 แนวตั้ง
└── lib/
    ├── api.ts                  เลือก mock หรือ HTTP จาก VITE_API_BASE_URL
    ├── supabase.ts             client สำหรับ auth เท่านั้น
    ├── catalogCache.ts         เก็บ catalog ลง IndexedDB
    ├── useLedger.ts            สมุดบัญชี + persist ลง localStorage ต่อรอบนับ
    ├── useScanner.ts           รวมสัญญาณจาก native plugin + ช่องพิมพ์เอง
    └── nativeScanner.ts        สะพานไป ScanBroadcastPlugin
```

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
pnpm build / typecheck / lint / test

pnpm db:generate          # สร้าง migration จาก schema.ts
pnpm db:migrate           # รันขึ้น DB จริง
pnpm db:seed

pnpm --filter @cycle-count/db upload:barcode-units R05106.CSV
pnpm --filter @cycle-count/db create:user
pnpm --filter @cycle-count/pda android:apk      # → android/app/build/outputs/apk/debug/

# เทสที่ยิงใส่ Postgres จริง — ไม่รวมใน `pnpm test` และไม่รันใน CI
pnpm --filter @cycle-count/web test:integration
```

**`pnpm test` ไม่แตะ DB** ทั้งหมดเป็น unit test + contract test ที่ mock `@/lib/db`
ส่วน `*.integration.test.ts` ยิงใส่ DB จริงเพราะต้องเห็นพฤติกรรมของ `public.stock`
ที่เราไม่ได้เป็นเจ้าของ — กติกาที่ทำให้ปลอดภัยพออยู่ใน `apps/web/src/test/integration.ts`

**`contract.test.ts` ของ `/api/pda/*` คือสัญญากับ APK ที่อยู่บนเครื่อง** ถ้าเทสชุดนั้นแดง
ให้ถามก่อนว่า "APK บนเครื่องรับการเปลี่ยนแปลงนี้ได้ไหม" ไม่ใช่แก้เทสให้ผ่าน

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

### 7.1 แอปจอขาวถาวรถ้าถูก pause ระหว่าง Capacitor bridge init

อาการ: เปิดแอปแล้วได้จอขาวเปล่า กดอะไรไม่ได้ ต้องฆ่าแอปเปิดใหม่ถึงจะหาย

```
D Capacitor: App started → Loading app at https://localhost
D Capacitor: App paused → App stopped              ← จอดับ / สลับแอป ตรงนี้
D Capacitor: Handling local request: /assets/index-*.js
E Capacitor/Console: Uncaught TypeError: Cannot read properties of undefined (reading 'triggerEvent')
```

native ยิง lifecycle event เข้า WebView ตอนที่ `window.Capacitor` ยังไม่ถูกฉีดเข้าไป
JS ตายตั้งแต่บรรทัดแรก React จึงไม่ mount

**เกิดง่ายมากตอนเทส** เพราะ timeout จอของเครื่องคือ 60 วินาที — เปิดแอปแล้วปล่อยจอดับ = เจอทุกครั้ง

**แก้แล้วสองชั้น**

1. `index.html` วาง stub ของ `window.Capacitor.triggerEvent` ไว้เป็น **script แรกสุด**
   ปลอดภัยเพราะทั้ง `@capacitor/core` และ `native-bridge.js` เริ่มด้วย
   `const cap = win.Capacitor || {}` คือ **ต่อยอด** ของเดิม ไม่ได้เช็คแล้วข้าม
   ของจริงจึงมาเขียนทับ stub ตอน bridge พร้อม
   → ตรวจซ้ำทุกครั้งที่อัป Capacitor major ว่ายังเป็นแบบนี้อยู่ (`src/lib/capacitorGuard.test.ts`)
2. `src/lib/crashScreen.ts` ดัก `error` / `unhandledrejection` และเช็คว่า `#root`
   ยังว่างหลัง 10 วินาทีไหม แล้วเปลี่ยนจอขาวเป็นข้อความที่กด "เปิดใหม่" ได้
   เขียนด้วย DOM API ล้วนไม่พึ่ง React เพราะ error พวกนี้เกิดก่อน React mount

### 7.2 WebView ของเครื่อง PDA ค้างที่ Chrome 113 อัปเดตไม่ได้

`com.android.webview 113.0.5672.136` (ปี 2023) บน Android 14 — vendor แช่ไว้
`com.google.android.webview` **ไม่ได้ติดตั้ง** จึงอัปเดตผ่าน Play ไม่ได้

`vite.config.ts` ยังไม่ได้ตั้ง `build.target` จึงพึ่งค่าเริ่มต้นของ Vite ซึ่งเปลี่ยนได้ตามเวอร์ชัน
(Vite 6 = `baseline-widely-available` ≈ Chrome 107 ซึ่งยังผ่าน แต่ Vite 7 เปลี่ยนอีก)
**ควรตั้งให้ชัดว่าเพดานคือ Chrome 113** ไม่ใช่ปล่อยตามค่าเริ่มต้น

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

---

## สิ่งที่แก้ไขล่าสุด

สถานะ ณ commit แรก (`2094ceb`) — งานที่ทำไปในรอบนี้

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

- **หน้าเว็บแอดมิน** — ยังไม่มีเลย ต้องมี: สร้างรอบนับ (เลือกสาขา + โหมด), กดปุ่ม `prepare`,
  อัปโหลด Excel, รายงานผลต่าง (ตีมูลค่าด้วย `resolvePrice()`)
- **หน้าเลือกรอบนับบน PDA** — ตอนนี้ยิง `/api/pda/session` แล้วได้รอบ active มาเลย
- **ผูกรอบทวนกับรอบแรก** (`parentSessionId`) เพื่อให้รอบทวนแสดงว่ารอบแรกนับได้เท่าไร
- **ตั้ง `build.target` ใน `vite.config.ts`** ให้ไม่เกิน Chrome 113 (ข้อ 7.2) — ตอนนี้พึ่งค่าเริ่มต้น
  ของ Vite ซึ่งเปลี่ยนได้เองเวลาอัปเวอร์ชัน
- **ยืนยันบั๊กจอขาว (ข้อ 7.1) บนเครื่องจริง** — แก้และเทสในโค้ดแล้ว แต่ยังไม่ได้ทดสอบซ้ำบนเครื่อง
- **offline queue ฝั่ง PDA** — ตอนนี้ส่งไม่สำเร็จแล้วต้องกดส่งใหม่เอง ไม่มี retry อัตโนมัติ
  และ `submit()` ไม่มี timeout จึงค้างที่ "กำลังส่ง…" ได้ตลอดกาลบนเน็ตที่ half-open

---

## วิธีเทสบนเครื่อง PDA จริง

เครื่องที่ใช้อยู่: **iT68** · Android 14 (SDK 34) · จอ 480×800 · WebView 113 (ดูข้อ 7.2)

### 0. ต้องมีอะไรบนเครื่อง dev ก่อน

`pnpm android:apk` ต้องการ JDK 17+ กับ Android SDK ซึ่งไม่ได้มากับ Node
ลงผ่าน scoop ได้โดย**ไม่ต้องใช้สิทธิ์ admin** และไม่ไปยุ่งกับ Java เดิมของเครื่อง

```powershell
scoop bucket add java; scoop bucket add extras
scoop install temurin21-jdk android-clt      # JDK 21 + cmdline-tools + platform-tools

# ยอมรับ license แล้วลง platform ตาม compileSdk
sdkmanager --licenses                         # ถ้าค้าง ให้เขียนไฟล์ hash ลง $ANDROID_HOME\licenses\ เอง
sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

ตั้งถาวรระดับ user: `JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`
และเพิ่ม `%JAVA_HOME%\bin`, `%ANDROID_HOME%\platform-tools` เข้า PATH

Gradle wrapper ในโปรเจกต์เป็น 8.7 อยู่แล้ว (ดูข้อ 10) ไม่ต้องลง Gradle แยก

### 1. เชื่อมเครื่อง

**ไร้สาย (Android 11+ ไม่ต้องเสียบ USB)** — Settings → Developer options → Wireless debugging
→ "Pair device with pairing code" จะได้ IP:port กับรหัส 6 หลัก

```bash
adb pair <ip>:<pairing-port> <รหัส 6 หลัก>
adb mdns services                    # หา port สำหรับ connect (คนละ port กับ pairing)
adb connect <ip>:<port>
```

จับคู่ครั้งเดียวจำได้ตลอด แต่ **หลุดทุกครั้งที่เครื่องหลับ** — ต่อใหม่ด้วย `adb connect` เฉย ๆ

### 2. build + ติดตั้ง

```bash
# .env ที่ root ต้องมี VITE_API_BASE_URL="http://localhost:3000"
adb reverse tcp:3000 tcp:3000        # ตั้งใหม่ทุกครั้งที่ต่อ adb ใหม่ / เครื่องรีบูต
pnpm --filter @cycle-count/web dev
pnpm --filter @cycle-count/pda android:apk
adb install -r apps/pda/android/app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n co.anin.cyclecount/.MainActivity
```

**ทำไมต้อง `adb reverse` ไม่ใช่ IP ใน LAN** — เครื่อง PDA จะมองเห็นพอร์ต 3000 ของคอม
ผ่านสาย adb โดยไม่ผ่าน Wi-Fi เลย ตัดปัญหา IP เปลี่ยน / subnet / firewall ออกทั้งหมด
และ `localhost` อยู่ใน `network_security_config.xml` อยู่แล้วจึงไม่ต้องแก้อะไร

**ถ้าจะใช้ IP ใน LAN จริง ๆ ต้องแก้สองที่ให้ตรงกัน** — นี่คือสาเหตุของ "failed to fetch"
ที่เคยหาไม่เจอ (ไม่ใช่ subnet หรือ AP isolation อย่างที่เดา แต่เป็น IP ค้างจาก DHCP):

| ที่ | หมายเหตุ |
|---|---|
| `.env` → `VITE_API_BASE_URL` | ฝังตอน build — แก้แล้วต้อง build APK ใหม่ |
| `android/app/src/debug/res/xml/network_security_config.xml` | ถ้า IP ไม่อยู่ในนี้ Android บล็อก cleartext ทั้งที่ URL ถูก |

Windows Firewall ไม่เกี่ยว (ตรวจแล้ว — profile ปิดอยู่ และมี inbound allow ของ node.exe)

### 3. ดูว่าเกิดอะไรขึ้นบนเครื่อง

```bash
adb logcat -c && adb logcat | grep -E "Capacitor|Capacitor/Console"   # JS error เห็นตรงนี้
adb shell screencap -p /sdcard/x.png && adb pull /sdcard/x.png        # ถ่ายจอ
adb shell "dumpsys power | grep mWakefulness="                        # เครื่องหลับอยู่ไหม
adb shell "dumpsys window | grep mCurrentFocus"                       # แอปไหนอยู่หน้าสุด
```

ฝั่ง server ดู log ที่ `withApi()` ออกให้ — หนึ่งบรรทัด JSON ต่อคำขอ มี `userId` กับ
`x-request-id` ติดมาด้วย จึงบอกได้ว่าเครื่องยิงอะไรเข้ามาและใครเป็นคนยิง

### 4. บัญชีทดสอบ

| รหัส | PIN | บทบาท |
|---|---|---|
| `EMP-901` | `901901` | counter — "ทดสอบ ก" |
| `EMP-902` | `902902` | counter — "ทดสอบ ข" |

สร้างเพิ่มด้วย `pnpm --filter @cycle-count/db create:user --code X --name Y --pin Z --role counter`
(รันซ้ำรหัสเดิม = เปลี่ยน PIN) PIN ต้องยาว ≥ 6 ตัวตามข้อกำหนดของ Supabase Auth

### 5. เทสที่ต้องเดินบนเครื่อง (เบราว์เซอร์แทนไม่ได้)

- **สแกนบาร์โค้ด** — Broadcast Mode รับผ่าน Android Intent (ข้อ 7) เบราว์เซอร์ไม่มีทางจำลอง
- **สมุดนับต้องไม่ปนข้ามผู้ใช้** — เครื่องคลังใช้ร่วมกันหลายคนต่อกะ เดินสองรอบ:
  1. ก ล็อกอิน → นับ → **กดส่ง** → ล็อกเอาต์ → ข ล็อกอิน → สมุดต้องว่าง
  2. ก ล็อกอิน → นับ → **ไม่กดส่ง** → ล็อกเอาต์ → ข ล็อกอิน → สมุดต้องว่าง
     แล้ว ก ล็อกอินกลับมา → **ของต้องอยู่ครบ** (ล็อกเอาต์ไม่ล้างสมุด ดู `lib/ledgerStorage.ts`)
- **แอปไม่จอขาวเมื่อถูก pause กลาง init** (ข้อ 7.1) — เปิดแอปแล้วกดปุ่ม power ภายใน 2 วินาที
  เปิดจอกลับมาต้องเห็นหน้าล็อกอิน ไม่ใช่จอขาว
- **โหมด blind ต้องไม่โชว์ยอดระบบ** — คอลัมน์ผลต่างต้องหายทั้งคอลัมน์ ไม่ใช่โชว์ `—`

### 6. กับดักที่เจอมาแล้ว

- **APK เซ็นคนละคีย์** — debug keystore เป็นของแต่ละเครื่อง build ถ้าเครื่อง PDA เคยลง APK
  จากอีกเครื่อง จะขึ้น `INSTALL_FAILED_UPDATE_INCOMPATIBLE` ต้อง `adb uninstall` ก่อน
  ซึ่ง **ลบข้อมูลในแอปทั้งหมด** รวมสมุดที่ยังไม่ได้ส่ง — ถามเจ้าของเครื่องก่อน
- **แอปติด "Waiting For Debugger"** ถ้าเคยตั้ง debug app ค้างไว้ →
  `adb shell am clear-debug-app; adb shell settings put global wait_for_debugger 0`
- **จอดับระหว่างเปิดแอป = จอขาว** (ข้อ 7.1 — แก้แล้วแต่ยังควรกันไว้ตอนเทส) →
  เสียบสายชาร์จ หรือ `adb shell settings put system screen_off_timeout 900000`
  (`svc power stayon true` ใช้ไม่ได้ถ้าเครื่องไม่ได้เสียบไฟ)
- **`adb exec-out screencap -p > x.png` ใน PowerShell ได้ไฟล์เสีย** (โดน BOM) →
  ใช้ `adb shell screencap -p /sdcard/x.png` แล้ว `adb pull`
- **Chrome DevTools ของ WebView** (`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>`)
  ใช้ได้ แต่ถ้า renderer ค้างอยู่แล้ว `Runtime.evaluate` จะ timeout ทุกคำสั่ง
  — อาการนั้นแปลว่า renderer ตาย ไม่ใช่ JS error ให้ดู logcat แทน
- **`process is bad` ใน logcat** = ActivityManager ขึ้นบัญชีดำ process ไว้จากการ crash ซ้ำ ๆ
  `pm clear` ไม่พอ ต้อง **reboot เครื่อง** (`adb reboot` — wireless debugging รอดหลังรีบูต)
