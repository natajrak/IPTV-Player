# BKL Play - IPTV Player

Web-based IPTV Player สำหรับดูวิดีโอสตรีมมิ่ง รองรับ HLS (.m3u8) และไฟล์วิดีโอทั่วไป

## การใช้งาน Web

### เปิดใช้งาน (Local)

1. ต้องมี [Node.js](https://nodejs.org/) ติดตั้งอยู่ในเครื่อง
2. รันคำสั่ง:
   ```bash
   npx serve . -p 4000
   ```
3. เปิดเบราว์เซอร์ไปที่ `http://localhost:4000/web/`

หรือบน Windows สามารถดับเบิลคลิกไฟล์ `serve-web.bat` แล้วเปิดเบราว์เซอร์ไปที่ `http://localhost:4000/web/`

### วิธีใช้งาน

1. **หน้าแรก** - แสดงหมวดหมู่หลัก (เช่น Anime, Movies) เป็นการ์ด คลิกเพื่อเข้าไปดูรายการภายใน
2. **เลือกหมวดหมู่ย่อย** - คลิกการ์ดเพื่อเจาะลึกลงไป เช่น Anime > The Series > เลือกเรื่อง
3. **เล่นวิดีโอ** - คลิกตอนที่ต้องการดู วิดีโอจะเปิดเป็น fullscreen overlay พร้อมปุ่มควบคุม
4. **เล่นตอนถัดไปอัตโนมัติ** - เมื่อดูจบตอน จะแสดง "เล่นถัดไป" พร้อมนับถอยหลัง 5 วินาที สามารถกด "เล่นเลย" หรือ "ยกเลิก" ได้
5. **Breadcrumb** - แถบด้านบนแสดงเส้นทางการนำทาง คลิกเพื่อย้อนกลับไปหมวดหมู่ก่อนหน้า
6. **ปิดวิดีโอ** - กดปุ่ม X หรือกด `Esc`
7. **กลับหน้าแรก** - คลิกโลโก้ "BKL Play" ที่มุมซ้ายบน

---

## โครงสร้าง Playlist

Playlist ใช้รูปแบบ JSON (.txt) แบ่งเป็น 2 ประเภทหลัก:

### 1. Group (หมวดหมู่)

ใช้สำหรับจัดกลุ่มรายการ สามารถซ้อนกันได้หลายระดับ

```json
{
  "name": "ชื่อหมวดหมู่",
  "image": "URL รูปปก",
  "author": "ชื่อผู้สร้าง (ถ้ามี)",
  "groups": [
    // ... group ย่อย หรือ stations
  ]
}
```

### 2. Station (ตอน/วิดีโอ)

ใช้สำหรับรายการวิดีโอที่เล่นได้

```json
{
  "name": "ชื่อตอน",
  "image": "URL รูป thumbnail",
  "url": "URL ของวิดีโอ (.m3u8 หรือ .mp4)",
  "referer": "Referer header (ถ้าจำเป็น)"
}
```

### 3. การอ้างอิง Playlist ภายนอก

สามารถใช้ `url` ในระดับ group เพื่อโหลด playlist จากไฟล์อื่น:

```json
{
  "name": "Solo Leveling",
  "image": "URL รูปปก",
  "url": "https://raw.githubusercontent.com/.../Solo-Leveling.txt"
}
```

---

## การเพิ่มรายการใน Playlist

### เพิ่มเรื่องใหม่ (Series)

1. สร้างไฟล์ `.txt` ในโฟลเดอร์ `playlist/` ตามหมวดหมู่ เช่น `playlist/Anime/Series/ชื่อเรื่อง.txt`
2. ใส่ข้อมูลในรูปแบบ JSON:

```json
{
  "name": "ชื่อเรื่อง",
  "image": "URL รูปปกเรื่อง",
  "referer": "Referer URL (ถ้าจำเป็น)",
  "groups": [
    {
      "name": "Season 1",
      "image": "URL รูปปก Season",
      "groups": [
        {
          "name": "พากย์ไทย",
          "image": "URL รูปปก",
          "stations": [
            {
              "name": "ตอนที่ 1",
              "image": "URL รูป thumbnail",
              "url": "URL วิดีโอ .m3u8 หรือ .mp4",
              "referer": "Referer URL (ถ้าจำเป็น)"
            },
            {
              "name": "ตอนที่ 2",
              "image": "URL รูป thumbnail",
              "url": "URL วิดีโอ"
            }
          ]
        }
      ]
    }
  ]
}
```

3. เพิ่มรายการอ้างอิงไปในไฟล์ `playlist/main.txt` ภายใน `groups` ของหมวดหมู่ที่ต้องการ:

```json
{
  "url": "https://raw.githubusercontent.com/natajrak/IPTV-Player/main/playlist/Anime/Series/ชื่อเรื่อง.txt",
  "name": "ชื่อเรื่อง",
  "image": "URL รูปปก"
}
```

### เพิ่มหมวดหมู่ใหม่

เพิ่ม group ใหม่ในไฟล์ `playlist/main.txt` ระดับบนสุด:

```json
{
  "name": "ชื่อหมวดหมู่ใหม่",
  "image": "URL รูปปก",
  "groups": [
    // ... เพิ่ม sub-groups หรือ stations
  ]
}
```

### หมายเหตุ

- `referer` ใช้ในกรณีที่เซิร์ฟเวอร์วิดีโอต้องการ Referer header เพื่ออนุญาตการเข้าถึง
- สามารถกำหนด `referer` ได้ทั้งระดับ playlist (ใช้กับทุก station) และระดับ station (ใช้เฉพาะ station นั้น)
- รองรับไฟล์วิดีโอ `.m3u8` (HLS) และ `.mp4`
- รูปภาพสามารถใช้ URL จากแหล่งใดก็ได้
