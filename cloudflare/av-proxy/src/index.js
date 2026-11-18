import handler from '../../../api/hls-proxy.js';

/**
 * HLS proxy ของหมวด AV บน Cloudflare Workers — ใช้ handler ตัวเดียวกับ Vercel (api/hls-proxy.js)
 * path ต้องเป็น /api/hls-proxy เหมือนเดิม เพราะ app.js ตรวจ URL ด้วย regex นี้
 */
export default {
  fetch(request) {
    if (new URL(request.url).pathname !== '/api/hls-proxy') {
      return new Response('Not found', { status: 404 });
    }
    return handler(request);
  },
};
