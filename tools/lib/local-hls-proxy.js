const path = require('path');
const { pathToFileURL } = require('url');
const { Readable, pipeline } = require('stream');

const HANDLER_PATH = path.join(__dirname, '..', '..', 'api', 'hls-proxy.js');

/** โหลด handler ของ Vercel (ESM) ครั้งเดียว — ใช้โค้ด proxy ชุดเดียวกับ production */
let handlerPromise = null;
function loadHandler() {
  if (!handlerPromise) handlerPromise = import(pathToFileURL(HANDLER_PATH).href).then((m) => m.default);
  return handlerPromise;
}

/**
 * HLS proxy ในเครื่อง (/api/hls-proxy) สำหรับเปิด player ผ่าน server.js
 * แปลง Node http request → Web Request ส่งให้ api/hls-proxy.js แล้ว stream Response กลับ
 * m3u8 ที่ rewrite จะชี้กลับมาที่ host ของ request นี้เอง (handler ใช้ url.origin)
 * ผู้ชมยกเลิกกลางคัน (seek) → pipeline ทำลาย stream ต้นทาง ปิด connection ไม่ค้าง
 */
async function handleLocalHlsProxy(req, res, port) {
  const host = req.headers.host || `localhost:${port}`;
  const headers = new Headers();
  for (const name of ['range', 'origin', 'accept']) {
    if (req.headers[name]) headers.set(name, req.headers[name]);
  }
  let response;
  try {
    const handler = await loadHandler();
    response = await handler(new Request(`http://${host}${req.url}`, { method: req.method, headers }));
  } catch (e) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    }
    res.end(`Local proxy error: ${e.message}`);
    return;
  }

  const cancelBody = () => { if (response.body) response.body.cancel().catch(() => {}); };

  /** ผู้ชมยกเลิกไประหว่างรอต้นทาง (seek / เปลี่ยนตอน) → pipe ลง socket ที่ปิดแล้วจะ throw จน server ดับ */
  if (res.destroyed || res.writableEnded) {
    cancelBody();
    return;
  }

  let src = null;
  try {
    const outHeaders = {};
    response.headers.forEach((value, name) => { outHeaders[name] = value; });
    res.writeHead(response.status, outHeaders);
    if (!response.body || req.method === 'HEAD') {
      cancelBody();
      res.end();
      return;
    }
    src = Readable.fromWeb(response.body);
    pipeline(src, res, () => {});
  } catch {
    if (src) src.destroy();
    else cancelBody();
    res.destroy();
  }
}

module.exports = { handleLocalHlsProxy };
