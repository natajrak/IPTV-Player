/**
 * วัดความยาวจริงของ stream จาก HLS playlist (ผลรวม #EXTINF)
 *
 * ใช้ยืนยันว่าเว็บแบ่งตอนพิเศษของ TMDB จริงหรือไม่ — TMDB บอก 50 นาที
 * แต่ stream จริงยาว 25 นาที = เว็บแบ่งเป็น 2 ตอน (ดู episode-map.js)
 */

const CF_PROXY = 'https://shy-haze-2452.natajrak-p.workers.dev';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept': '*/*',
};

async function fetchText(url, referer) {
  const res = await fetch(url, {
    headers: { ...HEADERS, ...(referer && { Referer: referer }) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** station ที่มี resolver flag → ขอ fresh stream URL จาก worker ก่อน */
async function resolveStreamUrl(url, resolver) {
  const endpoint = `${CF_PROXY}/resolve/${resolver}?url=${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, { headers: HEADERS });
  if (!res.ok) throw new Error(`resolver HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.stream) throw new Error(data?.error || 'no stream');
  return data.stream;
}

/** master playlist → media playlist แรก (ถ้าเป็น media อยู่แล้วคืนค่าเดิม) */
function firstVariant(body, baseUrl) {
  if (!/#EXT-X-STREAM-INF/i.test(body)) return null;
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (/^https?:\/\//.test(t)) return t;
    try { return new URL(t, baseUrl).href; } catch { return null; }
  }
  return null;
}

function sumExtinf(body) {
  let total = 0;
  for (const m of body.matchAll(/#EXTINF:\s*([\d.]+)/g)) total += Number(m[1]) || 0;
  return total;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRY_DELAYS_MS = [500, 1500, 3000];

async function measureOnce(url, referer, resolver) {
  let target = url;
  if (resolver) target = await resolveStreamUrl(url, resolver);

  let body = await fetchText(target, referer);
  const variant = firstVariant(body, target);
  if (variant) {
    target = variant;
    body = await fetchText(target, referer);
  }

  const seconds = sumExtinf(body);
  return seconds > 0 ? seconds / 60 : null;
}

/**
 * คืนความยาวเป็น "นาที" หรือ null ถ้าวัดไม่ได้
 * retry หลายรอบเพราะ resolver/CDN ตอบ 403/429/5xx สุ่มเมื่อยิงถี่ๆ
 */
async function measureDurationMinutes(url, { referer = '', resolver = null } = {}) {
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const mins = await measureOnce(url, referer, resolver);
      if (mins) return mins;
    } catch { /* retry */ }
    if (attempt < RETRY_DELAYS_MS.length) await sleep(RETRY_DELAYS_MS[attempt]);
  }
  return null;
}

module.exports = { measureDurationMinutes };
