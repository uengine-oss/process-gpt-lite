// Repetitive work on a page is progress, not "stuck" (2026-11-25 recording 「NotebookLM '제목없음' 노트북 모두 삭제」: more_vert →
// delete 삭제 → 삭제, again and again, each round one notebook fewer — stopped at 40 actions as 「같은 화면에서 멈춤」). Read only from
// structure: what the agent pressed (the action, the element's name — never the meaning of either) and the page as it looked just
// before (the numbered elements' texts and the lines of text, counted). Nothing here knows about tasks, cards or the database.
//
//   · a round: the agent's most frequent action in the trail (its anchor); the page just before each time it is taken is that
//     round's base. The other actions between two anchors are free (a scroll, a note, a menu that opens).
//   · progress, round to round: the base is a page never seen at an earlier base and something on it went away (one of the
//     things counted on it is fewer).
//   · stuck: the same action on a page that does not change, or rounds that come back to a page seen before — never progress
//     (the agent's own checks for those, lib/browser.js stale · looped, stop the task as before).
// The budget: BLOCK actions at a time, one more block while the last block made progress, never more than HARD.
import crypto from 'node:crypto'

export const BLOCK = 40
export const HARD = 160
// rounds a block needs before it counts as progress (two that went the same way could still be chance)
export const MIN_ROUNDS = 3

// What is on the page, counted: each numbered element (tag and text) and each line of text. → Map(thing → how many)
export function itemsOf(snap) {
  const m = new Map()
  const add = (k) => { if (k) m.set(k, (m.get(k) || 0) + 1) }
  for (const e of snap?.els || []) add(`el:${e.tag}:${String(e.text || '').trim()}`)
  for (const line of String(snap?.text || '').split('\n')) add(`tx:${line.replace(/\s+/g, ' ').trim()}`)
  return m
}
// the same page: its address and what is counted on it
export function keyOf(snap) {
  const items = [...itemsOf(snap)].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, n]) => `${k}×${n}`).join('\n')
  return crypto.createHash('sha1').update(`${snap?.url || ''}\n${items}`).digest('hex')
}
// one action without the page it was taken on: the tool and what it named (the element's name, the address, the text, the scroll)
export const sigOf = (name, args = {}, targetName = '') => `${name}|${targetName || ''}|${args.url || ''}|${args.text ?? ''}|${args.dy ?? ''}`
// a turn for the trail: { sig, key, items } — the page is the one the action was taken on
export const turnOf = (name, args, targetName, snap) => ({ sig: sigOf(name, args, targetName), key: keyOf(snap), items: itemsOf(snap) })

// the action the rounds are anchored on: the press or the typing taken most often (ties: the one taken first). Not a scroll: rolling
// on through an endless list shows new things every time and is no work done on them
export const ANCHORS = ['click', 'type']
function anchorOf(trail) {
  const n = new Map(), first = new Map()
  trail.forEach((t, i) => {
    if (!ANCHORS.includes(t.sig.split('|')[0])) return
    n.set(t.sig, (n.get(t.sig) || 0) + 1)
    if (!first.has(t.sig)) first.set(t.sig, i)
  })
  let best = null
  for (const [sig, c] of n) if (!best || c > n.get(best) || (c === n.get(best) && first.get(sig) < first.get(best))) best = sig
  return best
}
const gone = (a, b) => [...a].filter(([k, c]) => (b.get(k) || 0) < c).map(([k, c]) => [k, c - (b.get(k) || 0)])

// trail: [{ sig, key, items }] oldest first → { rounds, count, progress, how, anchor }
//   rounds: bases seen · count: rounds that made progress · progress: the last round made progress, at most one round in the
//   trail did not (a slow page that had not changed yet), none came back to an earlier page, and there are at least MIN_ROUNDS
//   bases · how: 'shrinks' when the page had fewer things after every progressing round, else 'distinct' (each round took
//   something different away while new things came in — a list that slides up, the next page of results)
// What went away has to be a numbered element, or at least two lines of text (a row) — one line alone may be a clock or a counter.
export function progressOf(trail, { min = MIN_ROUNDS } = {}) {
  const list = (trail || []).filter((t) => t && t.sig && t.items)
  const anchor = anchorOf(list)
  const bases = anchor ? list.filter((t) => t.sig === anchor) : []
  const none = { rounds: bases.length, count: 0, progress: false, how: '', anchor }
  if (bases.length < 2) return none
  const seen = new Set([bases[0].key])
  const size = (m) => [...m.values()].reduce((s, c) => s + c, 0)
  let count = 0, misses = 0, lastOk = false, shrinks = true
  for (let k = 1; k < bases.length; k++) {
    const a = bases[k - 1], b = bases[k]
    if (b.key === a.key) { misses++; lastOk = false; continue }
    // back on a page an earlier round saw: going round in circles, whatever happened in between
    if (seen.has(b.key)) return { ...none, count }
    seen.add(b.key)
    const out = gone(a.items, b.items)
    const ok = out.some(([item]) => item.startsWith('el:')) || out.filter(([item]) => item.startsWith('tx:')).reduce((s, [, c]) => s + c, 0) >= 2
    if (ok) { count++; if (size(b.items) >= size(a.items)) shrinks = false } else misses++
    lastOk = ok
  }
  const progress = bases.length >= min && lastOk && misses <= 1
  return { rounds: bases.length, count, progress, how: count ? (shrinks ? 'shrinks' : 'distinct') : '', anchor }
}

// The budget after `used` turns: one more block while the last block made progress (its own turns only), up to HARD.
// → { budget, extended, progress } (progress: progressOf of the whole trail, for the card's count)
export function budgetAfter(trail, used, budget, { block = BLOCK, hard = HARD } = {}) {
  const all = progressOf(trail)
  if (used < budget || budget >= hard) return { budget, extended: false, progress: all }
  // the rounds of the block that just ran (the trail holds acting turns only, at most one per turn)
  const recent = progressOf((trail || []).slice(-block))
  if (!recent.progress) return { budget, extended: false, progress: all }
  return { budget: Math.min(hard, budget + block), extended: true, progress: all }
}
