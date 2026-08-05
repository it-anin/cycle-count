---
name: db-schema-and-legacy-data
description: ใช้เมื่อแก้ packages/db (schema, migration, สคริปต์ CLI) หรือโค้ดที่อ่านข้อมูลจากระบบ POS เดิมใน public — กฎแยก schema, snapshot แช่แข็ง, กับดักข้อมูลเดิม 3 อย่าง, และคำสั่ง CLI ทั้งหมด
---

# packages/db — schema + สคริปต์

| ไฟล์ | หน้าที่ |
|---|---|
| `schema.ts` | ตารางทั้งหมด **ภายใต้ `pgSchema('cycle_count')`** |
| `external.ts` | ประกาศตารางของระบบเดิมในสถานะอ่านอย่างเดียว — **ห้าม import เข้า schema.ts** |
| `client.ts` | postgres-js + Drizzle ต่อด้วย role `postgres` |
| `uploadBarcodeUnits.ts` | โหลด R05106.CSV → `cycle_count.barcode_units` |
| `createUser.ts` | สร้าง Supabase Auth user + แถว `profiles` พร้อมกัน (รันซ้ำ = เปลี่ยน PIN) |
| `setUserActive.ts` | เปิด/ปิด/ดูรายชื่อบัญชี — แยกจาก createUser เพราะปิดบัญชีไม่ควรต้องกรอกชื่อ+PIN ใหม่ |
| `session.ts` | สร้าง/เปิดใช้/ดูรายการรอบนับ — สร้างเป็น draft เสมอ (ดูหัวข้อ "แพตเทิร์นสคริปต์ CLI") |
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

## ทุกตารางอยู่ใน schema `cycle_count` ไม่ใช่ `public`

โปรเจกต์ Supabase นี้**ใช้ร่วมกับระบบ POS ที่มีข้อมูล production อยู่แล้ว** ใน `public`

- `drizzle.config.ts` ตั้ง `schemaFilter: ['cycle_count']` — **ห้ามเปลี่ยนเป็น `public`**
  ไม่งั้น drizzle-kit จะ generate migration ที่ `DROP` ตารางของระบบเขาทิ้ง
- ทุกบรรทัดใน `0001_rls.sql` ต้อง qualify ด้วย `cycle_count.` เสมอ
- `external.ts` ต้องใช้ `pgTable()` **ไม่ใช่** `pgSchema('public')` (Drizzle throw ตอน runtime
  แล้วทุก route ที่ import `@cycle-count/db` จะ 500 พร้อมกันหมด เพราะ `index.ts` re-export ไฟล์นี้)
- `external.ts` ห้าม import เข้า `schema.ts`

## ยอดตั้งต้นต้องแช่แข็ง ห้ามอ่านสด

`public.stock` อัปเดตทุก 5 นาที `count_sessions.snapshot_at` คือ **cut-off ของรอบนับ**

ถ้าเปลี่ยนไปอ่านค่าสดตอนคำนวณผลต่าง: ของที่ถูกเบิกไประหว่างนับจะกลายเป็น "ของหาย"
แยกไม่ออกจากของหายจริง และรายงานเดิมจะให้เลขคนละค่าทุกครั้งที่เปิดดู

`prepare` จึงปฏิเสธถ้ารอบนั้นมีคนนับไปแล้ว (ต้องส่ง `force: true`)
และต้อง `syncCatalog()` **ก่อน** `snapshotExpected()` เสมอ เพราะ `expected_stock` มี FK ไป `products`

## ข้อมูลจากระบบเดิมมีสามกับดัก

1. **แถว `__probe__`** — sentinel ของสคริปต์ sync ฝั่งเขา ไม่กรองจะกลายเป็น SKU ปลอมในรอบนับ
2. **`qty` / `multiply` / `cost` เป็น `text`** — `'369.0000'::numeric` ผ่าน แต่เจอ `''` เมื่อไหร่
   ทั้ง statement ล้มและ snapshot ทั้งรอบพัง → ใช้ `numericOrZero()` ที่ guard ด้วย regex ก่อน cast
3. **`branch` มีหลายค่า** — ไม่กรองแล้วยอดตั้งต้นรวมทุกสาขาเข้าด้วยกัน

## ตัวคูณมาจาก R05106 ไม่ใช่ product_master

`product_master.multiply` เก็บได้ **ค่าเดียวต่อ SKU** แต่ของจริงหนึ่ง SKU มีหลายบาร์โค้ดคนละตัวคูณ

```
100098   แผง(1)  10แผง(10)  โหล(12)  กล่อง(50)
100397   ซอง(1)  โหล(12)  กล่อง24(24)  กล่อง(60)
```

`cycle_count.barcode_units` จึงเป็นแหล่งหลัก หน่วยฐาน = หน่วยที่ตัวคูณ = 1

**กับดักของไฟล์นี้: ชื่อสินค้ามี `"` เป็นหน่วยนิ้ว** เช่น `Klean Gauze 2" x 2"` โดยไม่ครอบ quote
CSV parser ที่ตีความ `"` กลางฟิลด์ว่าเปิด quote จะทำให้คอลัมน์เลื่อนทั้งแถวแล้วข้อมูล**หายเงียบ ๆ**
(เจอ 207 จาก 10,841 แถวตอนเทส) — `splitCsvLine()` จึงนับ `"` เป็น quote เฉพาะตอนอยู่ต้นฟิลด์

## แพตเทิร์นสคริปต์ CLI

`process.loadEnvFile()` → `parseArgs()` → **dynamic `import()`**
(ต้องโหลด env ก่อน ไม่งั้น client อ่าน `DATABASE_URL` ไม่เจอ) → ทำงาน → `process.exit(0)`
ทุกตัวรันซ้ำได้ (upsert ไม่ใช่ insert)

## เรื่องปลีกย่อยที่เคยกัดมาแล้ว

- **host `db.<ref>.supabase.co` มีแต่ AAAA record** — เครื่องที่ไม่มี IPv6 ต้องใช้ pooler
  `aws-1-ap-southeast-1.pooler.supabase.com` กับ username `postgres.<ref>`
- **รหัสผ่านที่มี `@` ต้อง percent-encode** เป็น `%40` ใน connection string

## คำสั่ง

```bash
pnpm db:generate          # สร้าง migration จาก schema.ts
pnpm db:migrate           # รันขึ้น DB จริง
pnpm db:seed

pnpm --filter @cycle-count/db upload:barcode-units R05106.CSV

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
