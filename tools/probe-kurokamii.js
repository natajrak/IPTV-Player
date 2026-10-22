const U = process.argv[2] || 'https://kurokamii.com/anime/396/episode/7616';
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8', Referer: 'https://kurokamii.com/' };
const fs = require('fs');
const urls = (s) => [...new Set(s.match(/https?:\\?\/\\?\/[^"'\s<>]*(akuma|watch|play|embed|stream|m3u8)[^"'\s<>]*/gi) || [])];
(async () => {
  const html = await (await fetch(U, { headers: H })).text();
  fs.writeFileSync('kurokamii-ep.html', html);
  const m = html.match(/data-page='([^']+)'/) || html.match(/data-page="([^"]+)"/);
  console.log('data-page:', !!m, '| iframe:', (html.match(/<iframe[^>]*>/gi) || []).join(' '));
  console.log('URLs in HTML:', urls(html));
  if (!m) return;
  const version = JSON.parse(m[1].replace(/&quot;/g, '"')).version;
  const res = await fetch(U, { headers: { ...H, 'X-Inertia': 'true', 'X-Inertia-Version': version,
    'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/plain, */*' } });
  const txt = await res.text();
  fs.writeFileSync('kurokamii-ep.json', txt);
  const data = JSON.parse(txt);
  console.log('status:', res.status, '| props keys:', Object.keys(data.props || {}));
  console.log('currentEpisode:', JSON.stringify(data.props?.currentEpisode, null, 2));
  console.log('URLs in JSON:', urls(txt));
})().catch((e) => console.error(e));
