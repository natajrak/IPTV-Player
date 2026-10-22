const fs = require('fs');
const B = ['https:', '', 'kurokamii.com'].join('/');
const H = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8', Referer: B + '/' };
const KW = /player|turnstile|uuid|api\/|akuma|axios/gi;
(async () => {
  const html = fs.readFileSync('kurokamii-ep.html', 'utf8');
  const data = JSON.parse(fs.readFileSync('kurokamii-ep.json', 'utf8'));
  console.log('component:', data.component);
  const uuid = data.props.currentEpisode.uuid;
  const view = ['https:', '', 'files.akuma-player.xyz', 'view', uuid].join('/');
  const r = await fetch(view, { headers: { ...H, Referer: ['https:', '', 'akuma-player.xyz', ''].join('/') } }).catch((e) => ({ status: String(e) }));
  console.log('akuma-player view:', r.status, r.text ? (await r.text()).slice(0, 120) : '');
  const seen = new Set();
  const queue = [...html.matchAll(/\/build\/assets\/([\w.-]+\.js)/g)].map((m) => m[1]);
  const out = [];
  while (queue.length && seen.size < 300) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const js = await (await fetch(B + '/build/assets/' + f, { headers: H })).text();
    for (const m of js.matchAll(/(?:assets\/|\.\/)([\w.-]+\.js)/g)) if (!seen.has(m[1])) queue.push(m[1]);
    if (!/currentEpisode|turnstile/i.test(js)) continue;
    out.push('##### ' + f);
    let last = -1;
    for (const m of js.matchAll(KW)) {
      if (m.index < last) continue;
      last = m.index + 200;
      out.push(js.slice(Math.max(0, m.index - 200), last).replace(/\s+/g, ' '));
    }
  }
  fs.writeFileSync('kurokamii-hits.txt', out.join('\n\n'));
  console.log('scanned', seen.size, 'js files | hit files:', out.filter((l) => l.startsWith('#####')));
})().catch((e) => console.error(e));
