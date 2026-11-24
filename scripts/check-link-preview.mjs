// What a link-preview crawler (KakaoTalk, Slack, Facebook) reads from Lite's page — without running it — and
// whether the picture it names loads. Exit 1 when a tag is missing, an address is not absolute or the picture
// does not load as a 1200×630 PNG. (Feature test: e2e/tests/feature/install-nudge.spec.js F-IN-08.)
//   node scripts/check-link-preview.mjs https://uengine.process-gpt.io/lite/
//   node scripts/check-link-preview.mjs http://localhost:18080/ --forwarded-host acme.example.com
// After a deploy KakaoTalk keeps its old preview for a while: https://developers.kakao.com/tool/clear/og
const args = process.argv.slice(2)
const url = args.find((a) => /^https?:\/\//.test(a))
const fwd = args.includes('--forwarded-host') ? args[args.indexOf('--forwarded-host') + 1] : null
if (!url) { console.error('usage: node scripts/check-link-preview.mjs <page url> [--forwarded-host <host>]'); process.exit(2) }

const UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php) kakaotalk-scrap/1.0'
const problems = []
const r = await fetch(url, { headers: { 'User-Agent': UA, ...(fwd ? { 'X-Forwarded-Host': fwd, 'X-Forwarded-Proto': 'https' } : {}) } })
if (!r.ok) { console.error(`${url}: HTTP ${r.status}`); process.exit(1) }
const html = await r.text()
const meta = {}
for (const m of html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"/g)) meta[m[1]] = m[2]
const need = ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:locale', 'twitter:card', 'twitter:title', 'twitter:description', 'twitter:image']
for (const k of need) if (!meta[k]) problems.push(`missing ${k}`)
for (const k of ['og:image', 'twitter:image']) if (meta[k] && !/^https?:\/\/[^/]+\//.test(meta[k])) problems.push(`${k} is not an absolute address: ${meta[k]}`)
if (meta['twitter:card'] && meta['twitter:card'] !== 'summary_large_image') problems.push(`twitter:card is ${meta['twitter:card']}`)
if (/__PGL_PUBLIC_URL__/.test(html)) problems.push('the build left __PGL_PUBLIC_URL__ in the page')
if (meta['og:image']) {
  const img = await fetch(meta['og:image'], { headers: { 'User-Agent': UA } }).catch((e) => ({ ok: false, status: e.message }))
  if (!img.ok) problems.push(`og:image does not load: ${img.status}`)
  else {
    const b = Buffer.from(await img.arrayBuffer())
    const png = b.subarray(1, 4).toString() === 'PNG'
    const size = png ? `${b.readUInt32BE(16)}×${b.readUInt32BE(20)}` : '?'
    if (!png || size !== '1200×630') problems.push(`og:image is ${png ? 'a PNG' : 'not a PNG'} of ${size} (${b.length} bytes)`)
    meta['(og:image)'] = `${size}, ${Math.round(b.length / 1024)} KB`
  }
}
for (const k of [...need, '(og:image)']) if (meta[k]) console.log(`${k.padEnd(20)} ${meta[k]}`)
if (problems.length) { console.error('\n' + problems.map((p) => `✗ ${p}`).join('\n')); process.exit(1) }
console.log('\n✓ link preview ok')
