// 산출물 보기: the whole document, the part under review in a band (docs/robo-dlc/plan-review.md §3.3).
import lite from '../../_runtime/lite.js'
const { t, esc, $, $$ } = lite
await lite.ready
const folder = lite.params.folder
let cur = null // the document on screen
let allDocs = []

$('#sibsLabel').textContent = t('이 단계의 산출물', 'This stage’s artifacts')
$('#tocLabel').textContent = t('목차', 'Contents')

async function show(path, focus = '', quote = '') {
  if (!path) return library()
  let d
  try { d = await lite.tool('artifact_doc', { folder, path, focus: focus || '' }) } catch (e) {
    $('#doc').innerHTML = `<p class="empty">${esc(t('문서를 열 수 없어요: ', 'Cannot open the document: '))}${esc(e.message)}</p>`
    return
  }
  cur = d
  allDocs = d.docs
  $('#where').innerHTML = `<b>${esc(d.name)}</b>${esc(d.stage.name)}${d.unit ? ' · ' + esc(d.unit) : ''}${d.stage.role ? ' · ' + esc(d.stage.role) : ''}`
  $('#crumb').textContent = d.path
  $('#sibs').innerHTML = d.siblings.map((s) => `<li><a data-open="${esc(s.path)}" class="${s.path === d.path ? 'on' : ''}">${esc(s.name)}</a></li>`).join('')
  $('#toc').innerHTML = d.headings.filter((h) => h.level <= 4).map((h) => `<li class="l${h.level}"><a data-go="h-${esc(h.id)}" id="toc-${esc(h.id)}">${esc(h.text)}</a></li>`).join('')
  const doc = $('#doc')
  doc.innerHTML = d.html
  // `inception/…/unit-of-work.md` named in the text opens that document
  for (const c of $$('code', doc)) {
    const p = resolve(c.textContent.trim())
    if (p) { c.classList.add('doclink'); c.dataset.open = p }
  }
  $('#focusChip').innerHTML = ''
  $('#main').scrollTop = 0
  if (d.focus) applyFocus(d.focus, quote)
}

// a document named in the text: a record path, or a file name of this record
function resolve(s) {
  if (!/\.md$/.test(s)) return null
  const p = s.replace(/^aidlc\/spaces\/[^/]+\/intents\/[^/]+\//, '')
  if (allDocs.includes(p)) return p
  const same = allDocs.filter((x) => x.split('/').pop() === p.split('/').pop())
  return same.find((x) => cur && x.startsWith(cur.path.split('/').slice(0, -1).join('/'))) || same[0] || null
}

// The focused part: a heading's section (up to the next heading of the same family — "ADR-005" after
// "ADR-004" — or a higher one), else the first block that holds the words (a table row, a list item).
function applyFocus(focus, quote) {
  const doc = $('#doc')
  let target = null
  if (focus.heading) {
    const h = doc.querySelector(`#h-${CSS.escape(focus.heading)}`)
    if (h) {
      const level = Number(h.tagName[1])
      const fam = (h.textContent.match(/^\s*([A-Za-z]+)[-\s]?\d/) || [])[1]
      const nodes = [h]
      for (let n = h.nextElementSibling; n; n = n.nextElementSibling) {
        const m = n.tagName.match(/^H(\d)$/)
        if (m) {
          const l = Number(m[1])
          if (l < level) break
          if (fam ? new RegExp(`^\\s*${fam}[-\\s]?\\d`, 'i').test(n.textContent) : l <= level) break
        }
        nodes.push(n)
      }
      const sec = document.createElement('section')
      sec.className = 'focus'
      sec.dataset.label = t('검토 중인 부분', 'Under review')
      sec.dataset.test = 'artifact-focus'
      h.before(sec)
      for (const n of nodes) sec.append(n)
      target = sec
      $(`#toc-${CSS.escape(focus.heading)}`)?.classList.add('hit')
    }
  }
  if (!target && focus.text) {
    const words = focus.text.replace(/[`"“”]/g, '').trim()
    const key = words.split(/\s+/)[0]
    const blocks = $$('td, li, p, h2, h3, h4, h5', doc)
    const hit = blocks.find((b) => b.textContent.includes(words)) || blocks.find((b) => key && b.textContent.includes(key))
    if (hit) {
      target = hit.tagName === 'TD' ? hit.parentElement : hit
      target.classList.add('focus-line')
      target.dataset.test = 'artifact-focus'
    }
  }
  if (quote && target) mark(target, quote)
  $('#focusChip').innerHTML = `<span class="fchip">${esc(t('초점', 'Focus'))}: ${esc(focus.text)}${target ? '' : esc(t(' (찾지 못함)', ' (not found)'))} <button id="clearFocus">${esc(t('전체 보기', 'Whole document'))}</button></span>`
  $('#clearFocus').onclick = () => show(cur.path)
  if (target) setTimeout(() => target.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60)
}

function mark(el, quote) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.nodeValue.indexOf(quote)
    if (i < 0) continue
    const r = document.createRange()
    r.setStart(n, i); r.setEnd(n, i + quote.length)
    r.surroundContents(document.createElement('mark'))
    break
  }
}

async function library() {
  const d = await lite.tool('artifact_docs', { folder }).catch(() => ({ docs: [] }))
  allDocs = d.docs.map((x) => x.path)
  const groups = new Map()
  for (const x of d.docs) {
    const k = `${x.phase}/${x.unit || ''}/${x.stage}`
    if (!groups.has(k)) groups.set(k, { title: x.stageName + (x.unit ? ` · ${x.unit}` : ''), docs: [] })
    groups.get(k).docs.push(x)
  }
  $('#where').innerHTML = `<b>${esc(t('산출물', 'Artifacts'))}</b>${esc(d.intent?.slug || '')}`
  $('#doc').innerHTML = `<div class="lib">${[...groups.values()].map((g) => `<h2>${esc(g.title)}</h2><ul>${g.docs.map((x) => `<li><a data-open="${esc(x.path)}">${esc(x.name)}</a></li>`).join('')}</ul>`).join('')}</div>`
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open],[data-go],[data-href],[data-ref]')
  if (!a) return
  e.preventDefault()
  if (a.dataset.open) return show(a.dataset.open)
  if (a.dataset.go) return document.getElementById(a.dataset.go)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  if (a.dataset.href) return lite.open(a.dataset.href)
  if (a.dataset.ref) { const p = resolve(a.dataset.ref.split('#')[0]); if (p) show(p) }
})
lite.on('params', (p) => show(p.path, p.focus, p.quote))
show(lite.params.path, lite.params.focus, lite.params.quote)
