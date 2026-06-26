/**
 * build-tv.js — Transpile web/js/app.js → web/js/app.tv.js
 *
 * เว็บ player เขียนด้วย JS สมัยใหม่ (optional chaining `?.`, nullish `??`)
 * ซึ่งเป็น syntax error บน browser ของ Smart TV รุ่นเก่า (Tizen 2018 / webOS 4-5,
 * engine = Chromium 53-76) → ไฟล์ทั้งไฟล์ parse ไม่ผ่าน → จอขาว
 *
 * Script นี้ down-level app.js ลงเป็น ES ที่ Chromium 53+ รันได้ แล้วเขียนออกเป็น
 * app.tv.js (ไฟล์ที่ index.html โหลดจริง) โดย source app.js ยังเขียนสมัยใหม่ได้ตามเดิม
 *
 * รัน: npm run build:tv   (หรือ node build-tv.js)
 */

const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");

const SRC = path.join(__dirname, "..", "web", "js", "app.js");
const OUT = path.join(__dirname, "..", "web", "js", "app.tv.js");

const source = fs.readFileSync(SRC, "utf8");

const result = babel.transformSync(source, {
  babelrc: false,
  configFile: false,
  compact: false,
  comments: false,
  sourceType: "script",
  presets: [
    [
      "@babel/preset-env",
      {
        targets: { chrome: "53" },
      },
    ],
  ],
});

let code = result.code;
const parts = [
  "/* AUTO-GENERATED from app.js by tools/build-tv.js — DO NOT EDIT. */",
  "/* แก้ที่ app.js แล้วรัน `npm run build:tv` เพื่อ regenerate ไฟล์นี้ */",
];

if (/regeneratorRuntime/.test(code)) {
  const regen = fs.readFileSync(
    require.resolve("regenerator-runtime/runtime.js"),
    "utf8",
  );
  parts.push(regen);
}

parts.push(code);
fs.writeFileSync(OUT, parts.join("\n") + "\n", "utf8");

const optChainLeft = (code.match(/\?\./g) || []).length;
console.log(`✓ ${path.relative(process.cwd(), OUT)} written`);
console.log(`  source: ${source.length} bytes → output: ${code.length} bytes`);
console.log(`  optional-chaining (?.) remaining in output: ${optChainLeft}`);
if (/regeneratorRuntime/.test(code))
  console.log("  + regenerator-runtime prepended (async/await transpiled)");
