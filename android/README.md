# BKL Play — Android APK (Player only)

WebView shell ที่ห่อ web player (`../web`) เป็นแอป Android เดียว รองรับทั้ง **Android TV** (D-pad/รีโมท, โผล่ใน TV home) และ **มือถือ/แท็บเล็ต** (touch) — ไม่รวม CMS

## โครงสร้าง

```
android/
├── app/
│   ├── build.gradle              # AGP 8.5.2, minSdk 21, target/compileSdk 34
│   └── src/main/
│       ├── AndroidManifest.xml   # LAUNCHER + LEANBACK_LAUNCHER, leanback/touchscreen required=false
│       ├── java/com/bkl/play/MainActivity.java   # WebView + BACK bridge + fullscreen วิดีโอ
│       ├── res/                  # ic_launcher (192px), banner (320x180), theme, strings
│       └── assets/web/           # สำเนา ../web (generate ตอน build ไม่ commit)
├── build.gradle, settings.gradle, gradle.properties
└── gradlew + gradle/wrapper/     # Gradle 8.7 (pinned)
```

## กลไกสำคัญ

- **D-pad**: ปุ่มลูกศร/OK ของรีโมทวิ่งเข้า WebView เป็น keydown ปกติ → ใช้ spatial-focus navigation เดิมใน `web/js/app.tv.js` ได้ทันที (ไม่ต้องเขียนเพิ่มฝั่ง native)
- **ปุ่ม BACK**: hardware BACK ยิงที่ระดับ Activity ไม่เข้า WebView → `MainActivity.onBackPressed()` เรียก JS `window.__nativeBack()` (= `handleTVBack()` ใน app.js) ถ้า return `true` = แอปถอยเอง (ปิด player / ปิด search / ถอย breadcrumb), ถ้า `false` = อยู่ราก → `finish()` ออกแอป
- **Bundle เว็บ**: gradle task `copyWebAssets` copy `../web` → `app/src/main/assets/web` ทุกครั้งก่อน build (exclude `cms/**`) ให้ shell ตรงกับ source เสมอ
- **Fullscreen วิดีโอ**: `WebChromeClient.onShowCustomView` รองรับปุ่มเต็มจอของ player

> playlist + stream ยังโหลดจากเน็ต (GitHub Raw / CDN) เหมือนเดิม — ตัว shell เท่านั้นที่ฝังในแอป

## Build

ต้องมี **JDK 17** และ **Android SDK** (platform-34, build-tools 34.0.0)

```bash
cd android
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
./gradlew :app:assembleDebug
```

ผลลัพธ์: `app/build/outputs/apk/debug/app-debug.apk`

> `local.properties` (มี `sdk.dir`) ถูก generate ให้แล้ว และไม่ commit

## ติดตั้งลงเครื่อง

```bash
adb connect <TV_IP>:5555          # Android TV ผ่าน network (เปิด ADB debugging ที่ TV ก่อน)
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

หรือก็อป `app-debug.apk` ใส่ USB → เปิดด้วย file manager บน TV แล้วกดติดตั้ง (ต้องอนุญาต "ติดตั้งจากแหล่งที่ไม่รู้จัก")

## อัปเดตเว็บแล้วอยากได้ APK ใหม่

1. แก้ `web/js/app.js` → `cd tools && npm run build:tv` (rebuild `app.tv.js`)
2. `cd android && ./gradlew :app:assembleDebug` (copyWebAssets ดึงเว็บล่าสุดให้เอง)

## หมายเหตุ

- APK นี้เป็น **debug build** (sideload ได้ ไม่ต้องเซ็น release) — ยังไม่ทำ signed release / Play Store
- bump version: แก้ `versionCode` / `versionName` ใน `app/build.gradle`
