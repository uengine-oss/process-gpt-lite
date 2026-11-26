// 글을 그리는 방법 — 남이 쓸 수 있는 Markdown 은 문서 요소로만 (스펙 openspec/specs/markdown-rendering).
// 에이전트의 답(메일 · 웹 페이지 · 동료의 말을 옮길 수 있다), 팀원의 지난 답, 회사 스킬, 단계의 결과, 양식의 값은 모두 다른 사람이 쓸 수 있는 글이다.
// 화면은 그 글을 src/safeMarkdown.js 한 곳에서 HTML 로 바꾼다: 문단 · 강조 · 목록 · 인용 · 코드 · 표 · 링크만 남고, 링크는 웹 주소 · 메일 · 이 사이트의
// 경로일 때만 주소를 가지며 새 탭으로 열린다. 글에 섞인 HTML 은 대화 화면에서 글자 그대로 보인다(예전처럼).
//   F-SH-01 safeMarkdown 을 브라우저에서 바로: 까다로운 입력 모음(속성 처리기 · javascript: 의 문자 참조 · 공백 · data: · vbscript: · SVG · MathML ·
//           <iframe srcdoc> · mXSS 고전)을 두 방식(html allow · text)으로 그려 실제 문서에 넣어도 실행되는 것이 없고, 보통 Markdown 은 그대로
//   F-SH-02 대화의 에이전트 답에 날 HTML · javascript: 링크: 글자로 보이고 실행되지 않음, 표 · 코드(「a < b && c」 그대로) · 새 탭 링크
//   F-SH-03 「이미 한 요청」 카드의 팀원 답(예전에는 날 HTML 을 그대로 그렸다): 같은 규칙
//   F-SH-04 스킬 초안 카드 → 「SKILL.md 전체 보기」 시트 · 작업 메모: 같은 규칙
//   F-SH-05 인스턴스 화면의 산출물(단계의 긴 글 결과): 같은 규칙
//   F-SH-06 페이지의 보안 정책: <object> · <base> 를 받지 않는다(index.html meta). 설치 번들의 nginx 는 남의 사이트가 앱을 틀에 넣지 못하게 하고,
//           저장소의 HTML · SVG · XML 은 따로 열려도 스크립트가 돌지 않게 한다(도커가 있으면 실제 nginx 로)
//   F-SH-07 작업실의 파일 원본: 그림 · 소리 · 영상 · PDF · 일반 텍스트가 아니면(.html · .xhtml · .svg · .xml · .xsl …) sandbox 정책으로
// 스택은 따로 띄운다(lib/localStack.js: 테넌트 safehtml-ui 의 BFF 와 Vite, 8971 · 5371 부터 빈 포트). 모델 · 공유 서비스 없음. 사람은 지어낸 이름.
//   cd e2e && RT_WORKERS=1 npx playwright test --project=feature tests/feature/safe-html.spec.js
import { test, expect } from '@playwright/test'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { startStack, REPO, freePort, waitFor } from '../../lib/localStack.js'

const TENANT = 'safehtml-ui'
test.describe.configure({ mode: 'serial' })
const SHOTS = process.env.SH_SHOTS || path.join(REPO, 'openspec/specs/markdown-rendering/e2e/results')
const DESK = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2, locale: 'ko-KR' }
const NOWHERE = 'http://127.0.0.1:9'
let S, ME
// the work folders of CLI-agent steps (PRO_CLI_WORKSPACE_ROOT): F-SH-07 puts an agent's files there
const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-safehtml-ws-'))

async function page(browser, who) {
  const ctx = await browser.newContext({ ...DESK, baseURL: S.web })
  await ctx.addInitScript((s) => { if (window.top === window) localStorage.setItem('pgpt-pro-session', s) }, JSON.stringify(who.session))
  const p = await ctx.newPage()
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  return p
}
const shot = async (loc, name) => {
  fs.mkdirSync(SHOTS, { recursive: true })
  await loc.page().waitForTimeout(300)
  await loc.screenshot({ path: path.join(SHOTS, `${name}.png`) })
}

// What a rendered block may hold (src/safeMarkdown.js): these elements, these attributes, links that are web · mail addresses.
// Checked on the live document (the page's own parser read it, as v-html does), plus nothing set window.__x.
const audit = (p, sel) => p.evaluate(async (sel) => {
  await new Promise((ok) => setTimeout(ok, 400))
  const TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'del', 's', 'code', 'pre', 'ul', 'ol', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'span', 'input'])
  const ATTRS = { a: ['href', 'title', 'target', 'rel'], input: ['type', 'checked', 'disabled'], th: ['align'], td: ['align'], ol: ['start'] }
  const bad = []
  const roots = [...document.querySelectorAll(sel)]
  for (const r of roots) {
    for (const el of r.querySelectorAll('*')) {
      if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml' || !TAGS.has(el.localName)) bad.push(`element <${el.localName}>`)
      for (const a of el.attributes) if (!(ATTRS[el.localName] || []).includes(a.name)) bad.push(`<${el.localName} ${a.name}="${a.value}">`)
      if (el.localName === 'a' && el.hasAttribute('href') && !['http:', 'https:', 'mailto:'].includes(el.protocol)) bad.push(`href ${el.getAttribute('href')}`)
      if (el.localName === 'a' && (el.target !== '_blank' || el.rel !== 'noopener noreferrer')) bad.push(`a without new tab: ${el.outerHTML}`)
    }
  }
  const page = {
    imgOnerror: document.querySelectorAll('img[onerror]').length,
    jsHref: [...document.querySelectorAll('a[href]')].filter((a) => /^(javascript|data|vbscript):/i.test(a.protocol)).length,
    frames: [...document.querySelectorAll(sel)].reduce((n, r) => n + r.querySelectorAll('iframe, object, embed, svg, math, script, style, img, base').length, 0),
  }
  return { roots: roots.length, bad, x: window.__x, page }
}, sel)
const clean = (r) => {
  expect(r.roots, 'the block is on the page').toBeGreaterThan(0)
  expect(r.bad, 'only plain document elements and attributes').toEqual([])
  expect(r.x, 'nothing ran').toBeUndefined()
  expect(r.page).toEqual({ imgOnerror: 0, jsHref: 0, frames: 0 })
}

// an answer an agent could have been led to write (a mail it read, a web page): raw HTML, script links, and ordinary Markdown
const PAYLOAD = [
  '보고서를 정리했어요.',
  '',
  '<img src=x onerror="window.__x=\'img\'"> <svg onload="window.__x=\'svg\'"></svg> <details open ontoggle="window.__x=\'details\'">',
  '[자세히 보기](javascript:window.__x=\'link\') · [두 번째](&#106;avascript:window.__x=\'entity\') · [누리집](https://example.com "예시 누리집")',
  '<iframe srcdoc="<script>parent.__x=\'frame\'</script>"></iframe>',
  '![차트" onerror="window.__x=\'alt\'](https://tracker.example/pixel.png)',
  '<math><mtext><table><mglyph><style><img src=x onerror="window.__x=\'mxss\'">',
  '',
  '| 항목 | 값 |',
  '|:---|---:|',
  '| 비교 | `a < b && c` |',
  '',
  '```js',
  'if (a < b && c) { go() }',
  '```',
].join('\n')

test.beforeAll(async () => {
  test.setTimeout(240_000)
  S = await startStack({ tenant: TENANT, apiFrom: 8971, webFrom: 5371, env: { PRO_DEEPAGENTS_URL: NOWHERE, PRO_COMPLETION_URL: NOWHERE, PRO_CONTEXT_ROUTER_URL: NOWHERE, PRO_CLI_WORKSPACE_ROOT: WS } })
  ME = await S.person('pro-rt-safehtml-ui-a@uengine.org', '윤하린')
  await S.join(ME)
})
const cleanups = []
test.afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch((e) => console.warn('[cleanup]', e.message))
  if (S) {
    await S.q(`delete from pro_messages where thread_id in (select id from pro_threads where user_id=$1)`, [ME?.id]).catch(() => {})
    await S.q(`delete from pro_threads where user_id=$1`, [ME?.id]).catch(() => {})
    await S.stop()
  }
  fs.rmSync(WS, { recursive: true, force: true })
})
async function room(title, messages) {
  const [t] = await S.q(`insert into pro_threads(user_id, kind, title) values ($1,'project',$2) returning id`, [ME.id, title])
  for (const [role, kind, content] of messages) await S.q(`insert into pro_messages(thread_id, role, kind, content) values ($1,$2,$3,$4)`, [t.id, role, kind, content])
  return t.id
}

test('F-SH-01 safeMarkdown: 까다로운 입력 모음은 실제 문서에 넣어도 실행되지 않고, 보통 Markdown 은 그대로 그린다', async ({ browser }) => {
  const p = await browser.newPage({ baseURL: S.web })
  p.errors = []
  p.on('pageerror', (e) => p.errors.push(String(e?.message || e)))
  await p.goto('/login')
  const r = await p.evaluate(async () => {
    const { safeMarkdown, cleanHtml, safeHref } = await import('/src/safeMarkdown.js')
    const C1 = String.fromCharCode(1)
    const T = '\t'
    // Markdown (and raw HTML inside Markdown)
    const MD = [
      '<img src=x onerror="window.__x=1">', '<IMG SRC=x OnErRoR=window.__x=2>', '<svg onload="window.__x=3"><script>window.__x=4</script></svg>',
      '<iframe srcdoc="<script>parent.__x=5</script>"></iframe>', '<a href="javascript:window.__x=6">a</a>', '[a](javascript:window.__x=7)',
      '[a](JaVaScRiPt:window.__x=8)', '[a](&#106;avascript:window.__x=9)', '[a](&#x6A;&#x61;vascript:window.__x=10)', `[a](<java${T}script:window.__x=11>)`,
      '[a]( javascript:window.__x=12)', '[a](javascript&colon;window.__x=13)', '[a](data:text/html;base64,PHNjcmlwdD5wYXJlbnQuX194PTE0PC9zY3JpcHQ+)',
      '[a](vbscript:msgbox(15))', '![x](javascript:window.__x=16)', '![x" onerror="window.__x=17](https://e.example/a.png)',
      '<math><mtext><table><mglyph><style><img src=x onerror="window.__x=18">', '<noscript><p title="</noscript><img src=x onerror=window.__x=19>">',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__x=20>', '<svg><style><img src=x onerror="window.__x=21"></style></svg>',
      '<math href="javascript:window.__x=22">m</math>', '<svg><a xlink:href="javascript:window.__x=23"><text>x</text></a></svg>',
      '<details open ontoggle="window.__x=24">d</details>', '<input autofocus onfocus="window.__x=25">', '<object data="javascript:window.__x=26"></object><embed src="javascript:window.__x=27">',
      '<base href="https://evil.example/">', '<style>@import "https://evil.example/x.css"; body{display:none}</style>', '<!--<img src=x onerror=window.__x=28>-->',
      '<table><tr><td><a href="javascript:window.__x=29">t</a>', '<xmp><img src=x onerror=window.__x=30></xmp>', '<title><img src=x onerror=window.__x=31></title>',
      '<textarea><img src=x onerror=window.__x=32></textarea>', '<scr<script>ipt>window.__x=33</script>', `<a href="${C1}javascript:window.__x=34">c</a>`,
      '<a href="https://ok.example" onclick="window.__x=35" style="color:red" target="_self" rel="opener">ok</a>', '<p style="background:url(javascript:window.__x=36)">s</p>',
      '<video><source onerror="window.__x=37"></video><audio src=x onerror="window.__x=38">', '<marquee onstart="window.__x=39">m</marquee>',
      '<form action="javascript:window.__x=40"><button>b</button></form>', '<a href="jav&#x09;ascript:window.__x=41">tab</a>', '<a href="&#14;javascript:window.__x=42">ctl</a>',
      '<isindex action="javascript:window.__x=43" type=image>', '<img src="x` `<script>window.__x=44</script>"` `>', '<a id="__x" name="__x" href="https://ok.example">clobber</a>',
      '<keygen autofocus onfocus="window.__x=45">', '<div onmouseover="window.__x=46">hover</div>', '<?xml-stylesheet href="javascript:window.__x=47"?>',
    ]
    const box = document.createElement('div')
    box.id = 'sh-box'
    document.body.appendChild(box)
    const out = []
    for (const s of MD) for (const html of ['allow', 'text']) for (const breaks of [true, false]) out.push(safeMarkdown(s, { html, breaks }))
    // the same strings handed in as HTML (a renderer of its own — cleanHtml)
    for (const s of MD) out.push(cleanHtml(s))
    box.innerHTML = out.map((h) => `<div class="sh">${h}</div>`).join('')
    // ordinary Markdown
    const doc = [
      '# 제목', '## 소제목', '', '3. 셋', '4. 넷', '', '| 왼쪽 | 가운데 | 오른쪽 |', '|:---|:---:|---:|', '| a | b | c |', '',
      '`a < b && c`', '', '```js', 'if (a < b && c) {}', '```', '', '- [x] 끝남', '- [ ] 남음', '',
      '[누리집](https://example.com "설명") <https://example.org> <nuri@example.com> [폴더](/folders/abc)', '', '> 인용', '', '~~지움~~ **굵게**은 *기울임*', '',
      '<div>안녕</div>', '', '그림 ![순서도](https://e.example/flow.png) 끝',
    ].join('\n')
    const norm = {}
    for (const html of ['allow', 'text']) {
      const d = document.createElement('div')
      d.innerHTML = safeMarkdown(doc, { html })
      document.body.appendChild(d)
      const q = (s) => d.querySelector(s)
      norm[html] = {
        h1: q('h1')?.textContent, h2: q('h2')?.textContent, olStart: q('ol')?.getAttribute('start'), li: [...d.querySelectorAll('ol li')].map((x) => x.textContent),
        align: [...d.querySelectorAll('th')].map((x) => x.getAttribute('align')), code: q('p > code')?.textContent, pre: q('pre code')?.textContent,
        boxes: [...d.querySelectorAll('input')].map((x) => [x.type, x.checked, x.disabled]),
        links: [...d.querySelectorAll('a')].map((a) => [a.getAttribute('href'), a.target, a.rel, a.title, a.textContent]),
        quote: q('blockquote')?.textContent.trim(), del: q('del')?.textContent, strong: q('strong')?.textContent, em: q('em')?.textContent,
        rawDiv: [...d.querySelectorAll('p')].some((x) => x.textContent === '<div>안녕</div>'), hasDiv: !!q('div'), plainHello: d.textContent.includes('안녕') && !d.textContent.includes('<div>'),
        img: !!q('img'), alt: [...d.querySelectorAll('p')].some((x) => x.textContent === '그림 순서도 끝'),
      }
    }
    const hrefs = Object.fromEntries(['https://a.example/x', 'mailto:a@b.example', '/folders/x', '#top', 'javascript:alert(1)', ' javascript:alert(1)', `java${T}script:alert(1)`, `${C1}javascript:x`, 'data:text/html,x', 'vbscript:x', 'file:///etc/passwd', '', null].map((h) => [String(h), safeHref(h) ?? null]))
    return { n: out.length, norm, hrefs }
  })
  clean(await audit(p, '#sh-box .sh'))
  expect(r.n).toBeGreaterThan(200)
  for (const mode of ['allow', 'text']) {
    const n = r.norm[mode]
    expect(n.h1).toBe('제목'); expect(n.h2).toBe('소제목')
    expect(n.olStart, '「3.」으로 시작한 목록은 3부터').toBe('3'); expect(n.li).toEqual(['셋', '넷'])
    expect(n.align).toEqual(['left', 'center', 'right'])
    expect(n.code, '코드는 쓴 그대로(&lt; 로 보이지 않음)').toBe('a < b && c'); expect(n.pre).toBe('if (a < b && c) {}\n')
    expect(n.boxes).toEqual([['checkbox', true, true], ['checkbox', false, true]])
    expect(n.links).toEqual([
      ['https://example.com', '_blank', 'noopener noreferrer', '설명', '누리집'], ['https://example.org', '_blank', 'noopener noreferrer', '', 'https://example.org'],
      ['mailto:nuri@example.com', '_blank', 'noopener noreferrer', '', 'nuri@example.com'], ['/folders/abc', '_blank', 'noopener noreferrer', '', '폴더'],
    ])
    expect(n.quote).toBe('인용'); expect(n.del).toBe('지움'); expect(n.strong, '한국어 조사 앞의 **굵게**').toBe('굵게'); expect(n.em).toBe('기울임')
    expect(n.img, '그림은 다른 사이트에 요청하지 않는다').toBe(false); expect(n.alt, '그림 자리에 대체 글').toBe(true)
    expect(n.hasDiv).toBe(false)
  }
  expect(r.norm.text.rawDiv, 'text: 글에 쓴 <div> 는 글자 그대로').toBe(true)
  expect(r.norm.allow.plainHello, 'allow: 허용하지 않는 태그는 벗기고 글만').toBe(true)
  expect(r.hrefs).toEqual({ 'https://a.example/x': 'https://a.example/x', 'mailto:a@b.example': 'mailto:a@b.example', '/folders/x': '/folders/x', '#top': '#top',
    'javascript:alert(1)': null, ' javascript:alert(1)': null, 'java\tscript:alert(1)': null, '\u0001javascript:x': null, 'data:text/html,x': null, 'vbscript:x': null,
    'file:///etc/passwd': null, '': null, null: null })
  expect(p.errors).toEqual([])
  await p.close()
})

test('F-SH-02 대화의 에이전트 답: 섞인 HTML 은 글자로, javascript: 링크는 주소 없이 — 표 · 코드 · 새 탭 링크는 그대로', async ({ browser }) => {
  const tid = await room('월간 보고 정리', [['user', 'text', { text: '이번 달 보고서 정리해 줘' }], ['agent', 'text', { text: PAYLOAD }]])
  const p = await page(browser, ME)
  await p.goto(`/projects/${tid}`)
  const bubble = p.locator('.row.r-agent.k-text .bubble.agent.md').last()
  await expect(bubble).toBeVisible({ timeout: 20000 })
  await expect(bubble).toContainText('<img src=x onerror=')
  await expect(bubble).toContainText('<iframe srcdoc=')
  clean(await audit(p, '.bubble.agent.md'))
  await expect(bubble.locator('a', { hasText: '자세히 보기' })).not.toHaveAttribute('href', /.*/)
  await expect(bubble.locator('a', { hasText: '두 번째' })).not.toHaveAttribute('href', /.*/)
  await expect(bubble.locator('a', { hasText: '누리집' })).toHaveAttribute('href', 'https://example.com')
  await expect(bubble.locator('a', { hasText: '누리집' })).toHaveAttribute('target', '_blank')
  await expect(bubble.locator('td code')).toHaveText('a < b && c')
  await expect(bubble.locator('pre code')).toHaveText('if (a < b && c) { go() }')
  await expect(bubble.locator('th').last()).toHaveAttribute('align', 'right')
  await expect(bubble).toContainText('차트')
  await shot(bubble, 'f-sh-02-chat')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-SH-03 「이미 한 요청」 카드의 팀원 답도 같은 규칙으로 그린다', async ({ browser }) => {
  const tid = await room('보고 다시 요청', [['user', 'text', { text: '월간 보고 정리해 줘' }], ['agent', 'repeat', {
    repeat_id: 'rp-safehtml', request: '월간 보고 정리해 줘', hits: [{ conv: 'conv-safehtml', title: '월간 보고 정리', owner_name: '박도윤', depth: 'content', at: new Date(Date.now() - 3600e3).toISOString(), prompt: '월간 보고 정리해 줘' }],
  }]])
  const p = await page(browser, ME)
  // the teammate's answer as the server reads it back (GET /context/repeats/:id/answer — its own tests: server/test/context-repeat*.test.js)
  await p.route('**/api/context/repeats/rp-safehtml/answer**', (r) => r.fulfill({ json: { owner_name: '박도윤', mine: false, turn: { at: new Date(Date.now() - 3600e3).toISOString(), answer: PAYLOAD } } }))
  await p.goto(`/projects/${tid}`)
  const card = p.locator('[data-testid=repeat-card]').last()
  await expect(card).toBeVisible({ timeout: 20000 })
  await card.getByRole('button', { name: '그 답 보기' }).click()
  const ans = card.locator('[data-testid=repeat-answer] .md')
  await expect(ans).toBeVisible()
  await expect(ans).toContainText('<img src=x onerror=')
  clean(await audit(p, '[data-testid=repeat-answer] .md'))
  await expect(ans.locator('td code')).toHaveText('a < b && c')
  await shot(card, 'f-sh-03-repeat')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-SH-04 스킬 초안의 SKILL.md 전체 보기 · 작업 메모도 같은 규칙으로 그린다', async ({ browser }) => {
  const md = ['---', 'name: monthly-report', 'description: 월간 보고 정리', '---', '# 월간 보고 정리', '', '1. 메일함에서 보고서를 찾는다', '2. 표로 정리한다', '',
    '<img src=x onerror="window.__x=\'skill\'">', '[설정 열기](javascript:window.__x=\'skill-link\')', '<script>window.__x=\'skill-script\'</script>', '',
    '```bash', 'grep -c "<tr>" report.html && echo ok', '```'].join('\n')
  const tid = await room('스킬 만들기', [['agent', 'skill_draft', { name: '월간 보고 정리', description: '메일의 월간 보고를 표로 정리', markdown: md, stepCount: 2, steps: ['메일함에서 보고서를 찾는다', '표로 정리한다'],
    note: '검토 메모 <img src=x onerror="window.__x=\'note\'"> [링크](javascript:window.__x=\'note-link\')' }]])
  const p = await page(browser, ME)
  await p.goto(`/projects/${tid}`)
  await p.getByRole('button', { name: /SKILL\.md 전체 보기/ }).click()
  const sheet = p.locator('.sheet[role=dialog]')
  await expect(sheet.locator('.md.scroll h1')).toHaveText('월간 보고 정리')
  await sheet.locator('details.note summary').click()
  await expect(sheet.locator('details.note .md')).toContainText('<img src=x onerror=')
  await expect(sheet.locator('.md.scroll')).toContainText('<script>window.__x=')
  await expect(sheet.locator('.md.scroll pre code')).toHaveText('grep -c "<tr>" report.html && echo ok')
  clean(await audit(p, '.sheet[role=dialog] .md'))
  await shot(sheet, 'f-sh-04-skill')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-SH-05 인스턴스 화면의 산출물(단계의 긴 글 결과)도 같은 규칙으로 그린다', async ({ browser }) => {
  const inst = await S.instance('월간 보고', [{ id: 'write', name: '보고서 작성' }], [ME], { owner: ME.id })
  cleanups.push(() => S.q('delete from todolist where proc_inst_id=$1', [inst.inst]))
  const report = `## 이번 달 요약\n\n${'매출과 비용을 정리했어요. '.repeat(12)}\n\n${PAYLOAD}`
  await S.q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, output, start_date, end_date)
             values (gen_random_uuid(),$1,$2,$3,$3,$4,'write','보고서 작성','DONE',$5, now() - interval '20 minutes', now() - interval '10 minutes')`,
  [S.tenant, ME.id, inst.inst, inst.def, { report_form: { summary: report } }])
  const p = await page(browser, ME)
  await p.goto(`/routines/${encodeURIComponent(inst.inst)}`)
  const doc = p.locator('.doc .inner.md').first()
  await expect(doc).toBeAttached({ timeout: 20000 })
  await expect(doc.locator('h2')).toHaveText('이번 달 요약')
  await expect(doc).toContainText('<img src=x onerror=')
  clean(await audit(p, '.doc .inner.md'))
  await expect(doc.locator('td code')).toHaveText('a < b && c')
  await shot(p.locator('.doc').first(), 'f-sh-05-instance')
  expect(p.errors).toEqual([])
  await p.context().close()
})

test('F-SH-06 페이지는 <object> · <base> 를 받지 않고, 설치 번들의 nginx 는 틀 넣기 · 저장소 HTML 의 스크립트를 막는다', async ({ browser }) => {
  const p = await browser.newPage({ baseURL: S.web })
  const csp = []
  p.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()) })
  await p.goto('/login')
  const r = await p.evaluate(async () => {
    const meta = document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content || ''
    const before = document.baseURI
    const b = document.createElement('base')
    b.href = 'https://evil.example/'
    document.head.appendChild(b)
    const after = document.baseURI
    const o = document.createElement('object')
    o.data = 'https://evil.example/x.swf'
    document.body.appendChild(o)
    await new Promise((ok) => setTimeout(ok, 300))
    return { meta, moved: before !== after }
  })
  expect(r.meta).toContain("object-src 'none'")
  expect(r.meta).toContain("base-uri 'self'")
  expect(r.moved, '<base> 가 주소를 옮기지 못한다').toBe(false)
  expect(csp.length, '브라우저가 정책으로 막았다고 알린다').toBeGreaterThan(0)
  await p.close()

  const conf = fs.readFileSync(path.join(REPO, 'install/docker/nginx.conf'), 'utf8')
  expect(conf).toContain(`add_header Content-Security-Policy "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"`)
  expect(conf).toMatch(/add_header Content-Security-Policy \$pgl_storage_csp always;/)
  expect(conf, 'S-52 가 보는 경로 묶음은 그대로').toContain('(auth|rest|storage)/v1/')

  // the real nginx (the web image's), when Docker and the image are here: headers of the app page and of storage's answers
  const docker = spawnSync('docker', ['image', 'inspect', 'nginx:1.27-alpine'], { encoding: 'utf8' })
  test.skip(docker.status !== 0, 'Docker 또는 nginx:1.27-alpine 이미지가 없음 — 설정 글만 확인')
  const upPort = freePort(8981)
  const webPort = freePort(18981)
  const TYPES = { html: 'text/html; charset=utf-8', svg: 'image/svg+xml', xml: 'application/xml', png: 'image/png', pdf: 'application/pdf', json: 'application/json' }
  const up = http.createServer((req, res) => { res.setHeader('Content-Type', TYPES[req.url.split('.').pop()] || 'application/json'); res.end('<script>1</script>') })
  await new Promise((ok) => up.listen(upPort, '0.0.0.0', ok))
  const name = `pgl-safehtml-nginx-${process.pid}`
  const html = fs.mkdtempSync(path.join(os.tmpdir(), 'pgl-safehtml-nginx-'))
  fs.writeFileSync(path.join(html, 'index.html'), '<!doctype html><title>t</title>')
  try {
    const gw = spawnSync('docker', ['run', '--rm', '--add-host', 'host.docker.internal:host-gateway', 'nginx:1.27-alpine', 'getent', 'hosts', 'host.docker.internal'], { encoding: 'utf8' }).stdout.split(/\s+/)[0]
    const run = spawnSync('docker', ['run', '-d', '--rm', '--name', name, '-p', `127.0.0.1:${webPort}:80`,
      '-e', 'LITE_RESOLVER=127.0.0.11', '-e', `LITE_SERVER=${gw}:${upPort}`, '-e', `LITE_OFFICE_HOST=${gw}:${upPort}`, '-e', `LITE_KONG=${gw}:${upPort}`, '-e', 'LITE_PUBLIC_ORIGIN=https://example.test',
      '-v', `${path.join(REPO, 'install/docker/nginx.conf')}:/etc/nginx/templates/default.conf.template:ro`, '-v', `${html}:/usr/share/nginx/html:ro`, 'nginx:1.27-alpine'], { encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    const head = async (u) => { const res = await fetch(`http://127.0.0.1:${webPort}${u}`); return [res.status, res.headers.get('content-security-policy')] }
    await waitFor(async () => (await head('/').catch(() => [0]))[0] === 200, 20000, 'nginx')
    const SAND = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
    expect(await head('/')).toEqual([200, "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"])
    expect(await head('/chat')).toEqual([200, "frame-ancestors 'self'; object-src 'none'; base-uri 'self'"])
    for (const f of ['a.html', 'a.svg', 'a.xml']) expect(await head(`/storage/v1/object/public/files/${f}`), f).toEqual([200, SAND])
    for (const f of ['a.png', 'a.pdf', 'a.json']) expect(await head(`/storage/v1/object/public/files/${f}`), f).toEqual([200, null])
    expect(await head('/rest/v1/x.html'), 'REST · 로그인 응답은 그대로').toEqual([200, null])
    expect(await head('/auth/v1/x.html')).toEqual([200, null])
  } finally {
    spawnSync('docker', ['rm', '-f', name])
    up.close()
    fs.rmSync(html, { recursive: true, force: true })
  }
})

test('F-SH-07 작업실의 파일 원본: 그림 · 소리 · 영상 · PDF · 일반 텍스트만 sandbox 없이, 나머지(.html · .xhtml · .svg · .xml · .xsl …)는 sandbox 로', async () => {
  const inst = await S.instance('작업실 파일', [{ id: 'build', name: '화면 만들기' }], [ME], { owner: ME.id })
  cleanups.push(() => S.q('delete from todolist where proc_inst_id=$1', [inst.inst]))
  const [t] = await S.q(`insert into todolist (id, tenant_id, user_id, proc_inst_id, root_proc_inst_id, proc_def_id, activity_id, activity_name, status, agent_mode, agent_orch, start_date)
                         values (gen_random_uuid(),$1,$2,$3,$3,$4,'build','화면 만들기','IN_PROGRESS','COMPLETE','cliagents', now()) returning id::text as id`, [S.tenant, ME.id, inst.inst, inst.def])
  const dir = path.join(WS, S.tenant, t.id)
  fs.mkdirSync(dir, { recursive: true })
  const page = '<html xmlns="http://www.w3.org/1999/xhtml"><body><script>window.__x=1</script></body></html>'
  const ACTIVE = ['a.html', 'a.htm', 'a.xhtml', 'a.xht', 'a.shtml', 'a.svg', 'a.xml', 'a.xsl', 'a.rdf', 'a.docx', 'a']
  const PASSIVE = ['a.png', 'a.jpg', 'a.mp4', 'a.mp3', 'a.pdf', 'a.txt', 'a.md', 'a.csv', 'a.json']
  for (const f of [...ACTIVE, ...PASSIVE]) fs.writeFileSync(path.join(dir, f), page)
  const head = async (f) => {
    const r = await fetch(`http://127.0.0.1:${S.apiPort}/api/workroom/todo/${t.id}/raw?path=${encodeURIComponent(f)}`, { headers: { Authorization: `Bearer ${ME.token}` } })
    await r.arrayBuffer()
    return [r.status, r.headers.get('content-security-policy'), r.headers.get('x-content-type-options')]
  }
  const SAND = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'"
  for (const f of ACTIVE) expect(await head(f), f).toEqual([200, SAND, 'nosniff'])
  for (const f of PASSIVE) expect(await head(f), f).toEqual([200, null, 'nosniff'])
})
