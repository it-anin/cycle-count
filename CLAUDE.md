# CLAUDE.md

คู่มือสำหรับ Claude Code เวลาทำงานกับ repo นี้ — อ่านก่อนแก้โค้ด
รายละเอียดการติดตั้ง/ใช้งานอยู่ใน [README.md](README.md) ไฟล์นี้เน้น **โครงสร้าง + กับดัก**

รายละเอียดเชิงลึกแยกไว้เป็น **skill** (`.claude/skills/<ชื่อ>/SKILL.md`) เพื่อไม่ต้องโหลด
ทุกอย่างเข้า context ทุกครั้งที่คุยกัน — ไฟล์นี้เป็นตัวชี้ทางว่าเรื่องไหนอยู่ skill ไหน
เจอสถานการณ์ในตารางข้างล่าง ให้เรียก skill นั้นก่อนอ่านโค้ดหรือเขียนโค้ดต่อ

---

## ระบบนี้คืออะไร

ระบบนับสต็อก (cycle count) ของ ANIN — พนักงานคลังใช้เครื่อง PDA (Android) ยิงบาร์โค้ดนับของ
เทียบกับยอดตั้งต้นที่ถ่ายมาจากระบบ POS เดิม แล้วออกรายงานผลต่างให้ผู้ตรวจสอบบัญชี

ขนาดจริง: **~8,200 SKU / ~10,800 บาร์โค้ด** ต่อรอบนับ

ภาษาในโค้ดและคอมเมนต์เป็น**ภาษาไทย** เขียนต่อให้เข้าชุดกัน

---

## เรียก skill ให้ถูกก่อนเริ่มงาน

| กำลังจะทำอะไร | เรียก skill |
|---|---|
| เพิ่ม/แก้ฟีเจอร์ใด ๆ ในระบบ (ก่อนเขียนโค้ดทุกครั้ง — ห้ามข้าม) | `feature-impact-check` |
| แก้โค้ดใน `apps/pda` (หน้าจอนับ, scanner, localStorage/IndexedDB, Android/Capacitor) | `pda-app-structure` |
| แก้โค้ดใน `apps/web` (route ใต้ `api/`, `server/*`, หน้าเว็บแอดมิน) | `web-app-conventions` |
| แก้ `packages/db` (schema, migration, สคริปต์ CLI) หรือแตะข้อมูลระบบ POS เดิมใน `public` | `db-schema-and-legacy-data` |
| ผู้ใช้ถามสถานะการใช้งานจริง / ประวัติการพัฒนา / ของที่ยังไม่ได้ทำ | `project-status` |

---

## กฎไม่มีเงื่อนไข — ไม่ต้องรอ skill บอกก็ห้ามพลาด

พลาดข้อไหนใน 4 ข้อนี้ผลกระทบรุนแรงและกว้างทันที (ข้อมูลระบบอื่นหาย / endpoint เปิดโล่ง /
ผู้ใช้ทั้งหมดล็อกอินไม่ได้) จึงเขียนไว้ตรงนี้ ไม่ฝากไว้ที่ skill ใดที่ต้องรอถูกเรียกก่อน:

1. **Schema ต้องเป็น `cycle_count` เท่านั้น** — ห้ามแก้ `schemaFilter` ใน `drizzle.config.ts`
   เป็น `public` ไม่งั้น drizzle-kit จะ generate migration ที่ `DROP` ตารางของระบบ POS เดิมทิ้ง
   (โปรเจกต์ Supabase นี้ใช้ร่วมกับระบบ POS ที่มีข้อมูล production จริงอยู่ใน `public` —
   รายละเอียดเต็ม → skill `db-schema-and-legacy-data`)
2. **ห้าม commit** `.env` / `.env.*` (มี service_role key + รหัส DB) / `*.CSV` / `*.xlsx`
   (ไฟล์ import ที่มีข้อมูลราคา/ยาเป็นความลับ) / `*.apk` และ**ห้าม ignore
   `apps/pda/android/`** ทั้งโฟลเดอร์ — ข้างในมีโค้ด native เขียนมือ สร้างใหม่จาก `cap add` ไม่ได้
3. **ทุก route handler ต้องมี `requireUser()` หรือ `requireRole()`** — RLS ไม่คุ้มเพราะ
   Drizzle ต่อ DB ด้วย role `postgres` ที่ bypass RLS ไว้ ลืมบรรทัดเดียว = endpoint เปิดโล่ง
   (รายละเอียดเต็ม + เคสที่เคยพลาดจริง → skill `web-app-conventions`)
4. **ห้ามเปลี่ยน `PDA_AUTH_DOMAIN` หรือ `authEmailForEmployee()`** โดยไม่อัปเดตพร้อมกันทั้ง
   หน้าเว็บ, PDA, และสคริปต์ `create:user` — ไม่งั้นผู้ใช้เดิมทั้งหมดล็อกอินไม่ได้ทันที
   (รายละเอียด → skill `pda-app-structure`)

`.env` อยู่ที่ **root ของ monorepo** ไม่ใช่ในแต่ละ app — `next.config.mjs`, `vite.config.ts`
และ `drizzle.config.ts` ต่างโหลดเองเพราะไม่มี framework ไหนมองขึ้นไปเหนือโฟลเดอร์ตัวเอง

---

## โครงสร้าง (ย่อ)

```
cycle-count/                    pnpm workspace + Turborepo
├── apps/
│   ├── web/                    Next.js 15 App Router → Vercel (region sin1)
│   └── pda/                    Vite + React 19 + Capacitor 6 → Android APK
└── packages/
    ├── core/                   ตรรกะบริสุทธิ์ + types ที่สองฝั่งใช้ร่วมกัน (มี unit test)
    └── db/                     Drizzle schema + migrations + สคริปต์ CLI
```

รายละเอียดไฟล์ในแต่ละแพ็กเกจ (ยกเว้น `core` ด้านล่าง) อยู่ใน skill ตามตารางข้างบน —
`apps/web` → `web-app-conventions`, `apps/pda` → `pda-app-structure`, `packages/db` →
`db-schema-and-legacy-data`

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

---

## คำสั่งพื้นฐาน

```bash
pnpm dev                  # web + pda
pnpm build / typecheck / test
```

คำสั่งเฉพาะ DB/CLI (migration, สร้างผู้ใช้, เปิด/ปิดรอบนับ, อัปโหลด CSV) →
skill `db-schema-and-legacy-data` · คำสั่ง build APK → skill `pda-app-structure`
