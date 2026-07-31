# Cycle Count — ระบบนับสต็อก

ระบบนับสต็อก (cycle count) ที่ใช้ข้อมูลหลักจาก Excel รองรับ SKU ~5,000–10,000 รายการ
ใช้นับบนเครื่อง PDA (Android) และมีหน้าเว็บสำหรับแอดมิน

## สถาปัตยกรรม

- **apps/web** — Admin web (Next.js App Router + TypeScript) → deploy Vercel
  อัปโหลด Excel, จัดการ price list, ตั้งรอบนับ, รายงาน/export
- **apps/pda** — PDA app (Vite + React ห่อด้วย Capacitor) → build เป็น Android APK
  login, เลือกรอบนับ, สแกนบาร์โค้ด + ใส่จำนวน, ส่งผล
- **packages/core** — โค้ดกลาง: types, Zod schemas, pricing logic, API client
- **packages/db** — Drizzle ORM schema + migrations + seed (Supabase Postgres)

Backend: **Supabase** (Postgres + Auth + Storage). Business logic อยู่ใน Next.js Route Handlers

## เริ่มต้น

```bash
# 1) เปิดใช้ pnpm (มากับ Node ผ่าน corepack)
corepack enable pnpm

# 2) ติดตั้ง dependencies
pnpm install

# 3) ตั้งค่า env
cp .env.example .env
#  แล้วกรอกค่าจากโปรเจกต์ Supabase

# 4) สร้าง/รัน migration + seed ข้อมูลตัวอย่าง
pnpm db:generate
pnpm db:migrate
pnpm db:seed

# 5) รัน dev (web + pda)
pnpm dev
```

## คำสั่งที่ใช้บ่อย

| คำสั่ง | ทำอะไร |
|---|---|
| `pnpm dev` | รันทุก app แบบ dev |
| `pnpm build` | build ทั้ง monorepo |
| `pnpm typecheck` | ตรวจ type ทั้งหมด |
| `pnpm test` | รัน unit test |
| `pnpm db:generate` | สร้าง migration จาก schema |
| `pnpm db:migrate` | รัน migration ขึ้น DB |
| `pnpm db:seed` | seed ข้อมูลตัวอย่าง |

## PDA — หน้าจอนับสต็อก

หน้าจอหลักใช้เลย์เอาต์ **"สมุดบัญชี"** ออกแบบสำหรับจอ 480×800 แนวตั้ง
รายการที่นับแล้วคือทั้งหน้าจอ ของที่เพิ่งยิงแทรกขึ้นหัวตาราง แตะแถวไหนก็แก้จำนวนได้ทันที
สมุดถูกเก็บลง `localStorage` ต่อรอบนับ — WebView รีโหลดหรือแบตหมดแล้วของที่นับไปไม่หาย

ตรรกะกลาง (รวมแถว, ผลต่าง, ยอดรวม) อยู่ที่ `packages/core/src/counting.ts` เป็น pure function พร้อม unit test

### โหมดของรอบนับ — ปิดยอด / รอบทวน

`count_sessions.mode` มีสองค่า **ค่าเริ่มต้นคือ `blind`**

| โหมด | ยอดระบบ | ใช้เมื่อ |
|---|---|---|
| `blind` | server **ไม่ส่ง** `expectedQty` ลง PDA เลย หน้าจอไม่มีคอลัมน์ผลต่าง | รอบนับแรก — **ผู้ตรวจสอบบัญชีบังคับ** |
| `recount` | ส่งยอดระบบตามปกติ เห็นผลต่างทุกแถว | รอบทวนเฉพาะตัวที่มีผลต่าง |

เหตุผลที่ต้องมี: ถ้าคนนับเห็นยอดระบบตั้งแต่รอบแรก ทางที่ง่ายที่สุดคือกดตามยอดโดยไม่นับจริง
(rubber-stamping) แล้วรายงานจะออกมาว่า "ตรงหมด" โดยที่ไม่มีใครรู้ว่าเกิดขึ้น

**การซ่อนใน UI อย่างเดียวไม่พอ** — catalog ทั้งก้อนอยู่ใน IndexedDB บนเครื่อง เปิด devtools ก็อ่านได้
`GET /api/pda/catalog` ของรอบ blind จึงตัด `leftJoin(expectedStock)` ทิ้งและ**ไม่ใส่คีย์
`expectedQty` ลงใน JSON เลย** ตรวจได้ด้วย:

```bash
curl -H "Authorization: Bearer $TOKEN" ".../api/pda/catalog?sessionId=$BLIND" | grep -c expectedQty
# ต้องได้ 0
```

ETag รวม `mode` ไว้ด้วย ไม่งั้นเครื่องที่โหลดตอนรอบเป็น recount แล้วแอดมินสลับกลับเป็น blind
จะได้ 304 แล้วใช้ยอดเก่าที่ค้างในเครื่องต่อ

ตอน dev สลับดูสองโหมดได้ด้วย `VITE_MOCK_MODE=recount pnpm dev` (ค่าเริ่มต้น `blind`)

### catalog บนเครื่อง

**ไม่มีการยิง HTTP ต่อการสแกนหนึ่งครั้ง** — catalog ทั้งรอบถูกโหลดลง IndexedDB ตอนเปิดรอบนับ
แล้ว `lookup()` ค้นจาก Map ในหน่วยความจำ จึงเป็น sync และตอบทันที
(20,000 บาร์โค้ด ≈ 400 KB หลัง gzip โหลดครั้งเดียวไม่กี่วินาที ครั้งถัดไปได้ 304 จาก ETag)

ล็อกอินด้วย **รหัสพนักงาน + PIN** ไม่ใช่อีเมล — `authEmailForEmployee()` ใน
`packages/core/src/auth.ts` แปลง `EMP-2041` → `emp2041@pda.anin.co.th` ให้ Supabase Auth
หน้าสร้างผู้ใช้ฝั่งแอดมินต้องเรียกฟังก์ชันเดียวกันนี้ ไม่งั้นจะ map ไปคนละบัญชี

ชั้นข้อมูลอยู่ที่ `apps/pda/src/lib/api.ts` เลือก implementation จาก env:

| env | ผล |
|---|---|
| ไม่ตั้ง `VITE_API_BASE_URL` | ใช้ mock catalog ในเครื่อง — `pnpm dev` แล้วกด “ยิงตัวอย่าง” ทดสอบได้เลย |
| ตั้ง `VITE_API_BASE_URL` | ยิง HTTP ไปที่ Next.js route handlers พร้อม Bearer token |

## เครื่องสแกน — Broadcast Mode

เครื่อง PDA ตั้งค่าเป็น **Data Output Mode: Broadcast Mode** (ไม่ใช่ keyboard-wedge)
เปลี่ยนไม่ได้เพราะแอปอื่นบนเครื่องใช้ค่านี้อยู่

บาร์โค้ดจึงมาเป็น Android Intent broadcast `com.kte.scan.result` ซึ่ง WebView รับเองไม่ได้
ต้องผ่าน `ScanBroadcastPlugin` ที่
[`android/app/src/main/java/co/anin/cyclecount/ScanBroadcastPlugin.java`](apps/pda/android/app/src/main/java/co/anin/cyclecount/ScanBroadcastPlugin.java)

**ผลคือเทสการสแกนในเบราว์เซอร์ไม่ได้ ต้อง build APK เท่านั้น**
(เทสเลย์เอาต์/ปุ่ม/คีย์แพดในเบราว์เซอร์ยังได้ ใช้ปุ่ม “คีย์เอง” พิมพ์บาร์โค้ดแทน)

### สัญญาณที่เครื่องส่งมา

| | ค่า |
|---|---|
| action | `com.kte.scan.result` |
| extra ที่มีบาร์โค้ด | **`code`** |
| extra ชนิดบาร์โค้ด | `code_src` (EAN13 / CODE128 / …) |

`code_src` อยู่ใน `IGNORED_KEYS` ของ plugin — **ห้ามเอามาเป็นบาร์โค้ดเด็ดขาด**
ถ้าเผลอหยิบมาใช้ ระบบจะบันทึกชื่อ symbology เป็นบาร์โค้ดโดยไม่มีใครสังเกต

ถ้าเจอเครื่องรุ่นอื่นที่ใช้คีย์ต่างออกไป plugin จะไล่เดาจาก `KNOWN_KEYS` ก่อน
แล้วถ้ายังไม่เจอจะส่ง extra ทุกตัวขึ้นมาแสดงเป็นตารางบนจอ (“รับสัญญาณสแกนได้ แต่หาบาร์โค้ดไม่เจอ”)
อ่านชื่อคีย์จากจอ PDA ได้เลยโดยไม่ต้องต่อสายดู logcat

### สองเรื่องที่ห้ามแก้พลาด

- **register receiver เฉพาะตอนแอปอยู่หน้าจอ** (`handleOnResume` / `handleOnPause`)
  broadcast เป็น multicast ถ้าประกาศไว้ใน AndroidManifest ถาวร แอปจะรับบาร์โค้ดตอนพนักงาน
  ใช้แอปอื่นอยู่ด้วย แล้วนับผีเข้ารอบ
- **`ContextCompat.RECEIVER_EXPORTED`** — targetSdk 34 บังคับ ไม่ใส่แล้ว crash ทันทีที่เปิดแอป
  เพราะ broadcast มาจากแอปอื่น (`androidx.core` ถูกประกาศตรงใน `app/build.gradle` เพื่อการนี้)

### ตั้งเครื่อง build ครั้งแรก

ต้องมี **JDK 17+** และ **Android SDK** — ไม่ต้องลง Android Studio ทั้งตัว (กิน ~12 GB)
ใช้แค่ commandline-tools (~3 GB รวม SDK) ก็พอ

```powershell
$sdk = "C:\Android\sdk"
Invoke-WebRequest "https://dl.google.com/android/repository/commandlinetools-win-15859902_latest.zip" -OutFile "$env:TEMP\cmdline-tools.zip"
Expand-Archive "$env:TEMP\cmdline-tools.zip" "$env:TEMP\cmdline" -Force
New-Item -ItemType Directory -Force "$sdk\cmdline-tools" | Out-Null
# โครงต้องเป็น cmdline-tools\latest\bin เป๊ะ ๆ ไม่งั้น sdkmanager ไม่ยอมรัน
Move-Item "$env:TEMP\cmdline\cmdline-tools" "$sdk\cmdline-tools\latest"

[Environment]::SetEnvironmentVariable("ANDROID_HOME", $sdk, "User")
$p = [Environment]::GetEnvironmentVariable("Path","User")
[Environment]::SetEnvironmentVariable("Path", "$p;$sdk\cmdline-tools\latest\bin;$sdk\platform-tools", "User")
$env:ANDROID_HOME = $sdk

& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" --licenses   # กด y จนจบ
& "$sdk\cmdline-tools\latest\bin\sdkmanager.bat" --sdk_root="$sdk" "platform-tools" "platforms;android-34" "build-tools;34.0.0"
```

เวอร์ชัน SDK ต้องตรงกับ `compileSdkVersion` ใน
[android/variables.gradle](apps/pda/android/variables.gradle) (ตอนนี้คือ 34)

**หมายเหตุเรื่อง Gradle** — Capacitor generate wrapper มาเป็น Gradle 8.2.1 ซึ่ง**ไม่รองรับ JDK 21**
(รองรับตั้งแต่ 8.5) จึงอัปเป็น 8.7 ใน `android/gradle/wrapper/gradle-wrapper.properties`
ถ้าลบโฟลเดอร์ `android/` แล้วรัน `cap add android` ใหม่ ต้องแก้บรรทัดนี้ซ้ำ

### build APK

```bash
pnpm --filter @cycle-count/pda android:apk
# → apps/pda/android/app/build/outputs/apk/debug/app-debug.apk

adb install -r apps/pda/android/app/build/outputs/apk/debug/app-debug.apk
```

หรือ `pnpm --filter @cycle-count/pda android:sync` แล้วเปิดใน Android Studio

**ก่อนทำ APK สำหรับใช้จริง** พิจารณาตั้ง `server.url` ใน
[capacitor.config.ts](apps/pda/capacitor.config.ts) ชี้ไปที่ Vercel — APK จะกลายเป็นเปลือกบาง
build ครั้งเดียวแล้วอัปเดตผ่าน Vercel ไม่ต้องไล่ลง APK ใหม่ทีละเครื่อง

## Backend

**Supabase (Postgres + Auth + Storage) + Next.js Route Handlers บน Vercel**

ตั้ง Supabase project ที่ region **Singapore** และบังคับ Vercel function ไป `sin1` ด้วย
(ทุก route handler ประกาศ `export const preferredRegion = 'sin1'`)
ถ้าปล่อย default function จะรันที่ US แล้วคุย DB ที่ Singapore เพิ่ม ~400 ms ต่อ query

### endpoints

```
GET  /api/pda/session               → { user, session }
GET  /api/pda/catalog?sessionId=... → { sessionId, generatedAt, entries }   รองรับ ETag/304
POST /api/pda/count-lines           → { saved }                             upsert กันซ้ำ
POST /api/import/upload-url         → { batchId, bucket, path, token }      แอดมินเท่านั้น
POST /api/import/process            → { imported, errorCount, errors }      แอดมินเท่านั้น
```

### เรื่องที่ต้องรู้ก่อนแก้โค้ดฝั่ง server

- **RLS ไม่คุ้ม Drizzle** — `packages/db/src/client.ts` ต่อ Postgres ด้วย role `postgres` ซึ่ง BYPASSRLS
  การตรวจสิทธิ์จริงต้องเรียก `requireUser()` / `requireRole()` จาก `apps/web/src/server/auth.ts`
  ทุก route ส่วน policy ใน migration `0001_rls.sql` เป็นเกราะชั้นสองกรณี anon key หลุด
- **ไฟล์ Excel ไม่ผ่าน route handler** — Vercel จำกัด body 4.5 MB
  เบราว์เซอร์อัปโหลดตรงเข้า Supabase Storage ด้วย signed URL แล้วค่อยเรียก `/api/import/process`
- **รอยต่อ ERP** — `apps/web/src/server/import/upsert.ts` รับ typed rows ล้วน ไม่รู้จัก Excel
  วันที่ต่อ ERP เพิ่มแค่ route ที่ map payload แล้วเรียกฟังก์ชันเดิม

### ทุกตารางอยู่ใน schema `cycle_count` ไม่ใช่ `public`

โปรเจกต์ Supabase นี้**ใช้ร่วมกับระบบอื่น**ที่มีข้อมูล production อยู่ใน `public` แล้ว
ตารางของระบบนับสต็อกจึงอยู่ใน Postgres schema แยกชื่อ `cycle_count`

เหตุผล — ถ้าวางไว้ใน `public` จะเกิดสองอย่าง:

1. **ชื่อชนกัน** — `products`, `prices` และโดยเฉพาะ `profiles` ซึ่งเป็นชื่อ convention ของ Supabase
2. **migration RLS จะไปเปิด RLS ทับตารางของระบบอื่น** ซึ่งไม่มี policy รองรับ
   = ปฏิเสธทุก query = ระบบเขาล่มทันที

`drizzle.config.ts` ตั้ง `schemaFilter: ['cycle_count']` ไว้ **ห้ามเปลี่ยนกลับเป็น `public`**
ไม่งั้น drizzle-kit จะ generate migration ที่ `DROP` ตารางของระบบอื่นทิ้ง เพราะไม่มีใน `schema.ts` ของเรา

**ทุกบรรทัดใน `0001_rls.sql` ต้อง qualify ด้วย `cycle_count.` เสมอ**

ผลพลอยได้: schema นี้ไม่ถูก expose ให้ PostgREST ของ Supabase (ค่าเริ่มต้นเปิดแค่ `public`)
ตารางเราจึงยิงผ่าน REST API ตรง ๆ ไม่ได้เลย ปลอดภัยกว่า RLS อีกชั้น

### ดึงข้อมูลจากระบบสต็อกเดิม

ระบบเดิมอยู่ใน `public` ของ Supabase ตัวเดียวกัน ประกาศไว้แบบอ่านอย่างเดียวที่
[packages/db/src/external.ts](packages/db/src/external.ts) — **ห้าม import เข้า `schema.ts`**
ไม่งั้น drizzle-kit จะ generate migration ที่ไปแก้ตารางของระบบเดิม

| แหล่ง | ใช้เป็น |
|---|---|
| **`cycle_count.barcode_units`** (จากรายงาน POS R05106) | **แหล่งหลักของบาร์โค้ด + ตัวคูณ** |
| `public.products` (หนึ่งแถว = หนึ่งบาร์โค้ด) | เติมบาร์โค้ดที่ไม่มีใน R05106 (ตัวคูณถือเป็น 1) |
| `public.product_master` | ชื่อสินค้า + หมวด |
| `public.stock` (`branch`, `sku`, `qty`, `unit`) | `cycle_count.expected_stock` |

### ตัวคูณต้องมาจาก R05106 ไม่ใช่ product_master

`product_master.multiply` เก็บได้ **ค่าเดียวต่อ SKU** แต่ของจริง SKU หนึ่งมีหลายบาร์โค้ด
ที่ตัวคูณต่างกัน — ใช้ไม่ได้:

```
100098  แผง(1)  10แผง(10)  โหล(12)  กล่อง(50)     ← 4 บาร์โค้ด 4 ตัวคูณ
100397  ซอง(1)  โหล(12)  กล่อง24(24)  กล่อง(60)
```

อัปโหลดไฟล์เข้า `cycle_count.barcode_units` ด้วย

```bash
pnpm --filter @cycle-count/db upload:barcode-units R05106.CSV
```

หน่วยฐานของแต่ละ SKU = หน่วยที่ตัวคูณ = 1 (ตรวจกับไฟล์จริง 10,841 แถวแล้ว ทุก SKU มีเสมอ)

**กับดักของไฟล์นี้: ชื่อสินค้ามี `"` เป็นหน่วยนิ้ว** เช่น `Klean Gauze 2" x 2"` และไม่ได้ครอบด้วย quote
CSV parser ที่ตีความ `"` กลางฟิลด์ว่าเปิด quote จะทำให้คอลัมน์เลื่อนทั้งแถวแล้วข้อมูลหายเงียบ ๆ
(เจอ 207 แถวตอนเทส) — `splitCsvLine()` จึงนับ `"` เป็นตัวคั่นเฉพาะตอนอยู่ต้นฟิลด์เท่านั้น

ตรรกะทั้งหมดอยู่ที่ [apps/web/src/server/stock/sync.ts](apps/web/src/server/stock/sync.ts)
เรียกผ่าน `POST /api/admin/sessions/prepare` ซึ่งทำ **ตามลำดับนี้เท่านั้น** —
sync catalog ก่อน แล้วค่อย snapshot เพราะ `expected_stock` มี FK ไป `products`

#### สามกับดักของข้อมูลต้นทาง

1. **แถว `__probe__`** — sentinel ของสคริปต์ sync ถ้าไม่กรองจะกลายเป็น SKU ปลอมในรอบนับ
2. **`qty` / `multiply` / `cost` เป็น `text`** — `'369.0000'::numeric` ใช้ได้ แต่เจอ `''`
   หรือข้อความเมื่อไหร่ทั้ง statement ล้มและ snapshot ทั้งรอบพัง กันด้วย regex ก่อน cast เสมอ
3. **`branch` มีหลายค่า** — ไม่กรองแล้วยอดตั้งต้นจะรวมทุกสาขา

#### ยอดตั้งต้นต้องแช่แข็ง ห้ามอ่านสด

`public.stock` อัปเดตทุก 5 นาที `count_sessions.snapshot_at` จึงเป็น **cut-off ของรอบนับ**

ห้ามเปลี่ยนไปอ่านค่าสดตอนคำนวณผลต่าง เพราะ:

- **ของที่ถูกเบิกไประหว่างนับจะกลายเป็น "ของหาย"** แยกไม่ออกจากของหายจริง
- ไม่มี cut-off ให้อ้าง กระทบงบการเงินโดยตรง
- รายงานเดิมจะให้ผลต่างคนละค่าทุกครั้งที่เปิดดู

`prepare` จะปฏิเสธถ้ารอบนั้นมีคนนับไปแล้ว (ต้องส่ง `force: true`) เพราะการถ่ายใหม่
= เลื่อน cut-off = ผลต่างของที่นับไปแล้วเปลี่ยนความหมาย

#### ข้อจำกัดที่ยังเหลือ — หน่วยต้องตรงกัน

`expected_stock` เก็บตามหน่วยที่ `public.stock` บันทึกไว้ (เช่น `กล่อง`)
ถ้าพนักงานสแกนบาร์โค้ด `ลัง` ของ SKU เดียวกัน จะไม่มียอดตั้งต้นให้เทียบ → ขึ้นเป็น "ยังตัดสินไม่ได้"

**ไม่ใช่ผลต่างผิด แต่เป็นผลต่างที่ยังไม่รู้** ซึ่งปลอดภัยกว่า
ทางแก้ระยะยาวคือเทียบกันที่หน่วยฐานโดยใช้ `uom_conversions.factor_to_base`
(ฝั่ง PDA มีค่านี้อยู่แล้วใน catalog และ `ledgerTotals()` คำนวณ `totalBaseQty` ได้อยู่)

### ตั้งค่าที่ต้องทำใน Supabase ก่อนใช้งาน

1. สร้าง bucket ชื่อ `imports` แบบ private (เก็บไฟล์ Excel ที่อัปโหลด)
2. รัน `pnpm db:migrate` — migration `0001_rls.sql` เปิด RLS และสร้าง policy ให้เอง
3. สร้างผู้ใช้ใน Supabase Auth ด้วยอีเมลจาก `authEmailForEmployee()` แล้วเพิ่มแถวใน `profiles`
4. ขึ้นแพ็กเกจ **Pro** ก่อนใช้จริง — free tier หยุด project เองเมื่อไม่มีทราฟฟิก 7 วัน
   ซึ่งระบบนับสต็อกที่ใช้เดือนละครั้งจะโดนเต็ม ๆ

## สถานะ

ทำแล้ว: โครง monorepo, schema (ขึ้น Supabase จริงแล้ว), หน้าจอนับสต็อกบน PDA,
backend ทั้งชุด, โปรเจกต์ Android พร้อม plugin รับ broadcast จากเครื่องสแกน

ยังไม่ได้ทำ: หน้าเว็บแอดมิน (อัปโหลด Excel, จัดการรอบนับ, รายงานผลต่าง)
และหน้าเลือกรอบนับบน PDA

รายละเอียดกฎที่ห้ามละเมิดตอนแก้โค้ด ดูที่ [CLAUDE.md](CLAUDE.md)
