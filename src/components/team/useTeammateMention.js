// "@" in the chat composer: a list of teammates (and roles) near the caret, and the person chips the
// next message goes to. Kept apart from the document-object mentions (app.mentions: @표 2, @이미지 1),
// which come from clicks in an open document, not from typing.
// Order: the ones I hand things to most → the ones the judge reads as related → roles → everyone else.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useApp } from '../../stores/app.js'
import { useTeam } from '../../stores/team.js'

// where the caret is inside a textarea, in the textarea's own pixels (a mirror div with the same text)
function caretXY(ta) {
  const s = getComputedStyle(ta)
  const d = document.createElement('div')
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingLeft', 'paddingRight', 'borderLeftWidth', 'boxSizing', 'whiteSpace', 'wordWrap']) d.style[p] = s[p]
  Object.assign(d.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', wordWrap: 'break-word', width: `${ta.clientWidth}px`, top: 0, left: 0 })
  d.textContent = ta.value.slice(0, ta.selectionStart)
  const mark = document.createElement('span')
  mark.textContent = '​'
  d.appendChild(mark)
  document.body.appendChild(d)
  const out = { x: mark.offsetLeft - ta.scrollLeft, y: mark.offsetTop - ta.scrollTop }
  d.remove()
  return out
}

export function useTeammateMention(text, ta, enabled = true) {
  const app = useApp()
  const team = useTeam()
  const open = ref(false)
  const query = ref('')
  const at = ref(-1)          // index of the '@' being completed
  const x = ref(0)
  const active = ref(0)
  const chips = ref([])       // [{type:'user', id, label} | {type:'role', role, label}]
  const fast = ref(null)
  const related = ref([])
  const judging = ref(false)
  let seq = 0

  // what the work is: the conversation being viewed (or the last few messages of this thread)
  function context() {
    const list = app.thread || []
    // the conversation the latest message belongs to (context-router), or the one being viewed
    const of = app.mainThread && app.activeId === app.mainThread.id ? app.convOf : {}
    const last = [...list].reverse().find((m) => of[m.id])
    const cid = app.convFilter || (last && of[last.id]) || null
    const conv = cid ? app.convList.find((c) => c.id === cid) : null
    const recent = (cid ? list.filter((m) => of[m.id] === cid || !of[m.id]) : list).slice(-14)
    return {
      title: conv?.title || (app.active?.kind === 'project' ? app.active.title : '') || '',
      conversation: cid ? { id: cid, title: conv?.title || '' } : null,
      contextIds: recent.filter((m) => ['text', 'doc', 'file'].includes(m.kind) && !m.content?.team).map((m) => m.id),
      artifactIds: recent.filter((m) => m.kind === 'file' && /\/storage\/v1\/object\/public\//.test(m.content?.url || '')).slice(-3).map((m) => m.id),
    }
  }

  async function load() {
    const my = ++seq
    if (!team.people || Date.now() - team.people.at > 30000) await team.suggest('fast').catch(() => null)
    if (my !== seq) return
    fast.value = team.people
    related.value = []
    const c = context()
    if (!c.contextIds.length) return
    judging.value = true
    const r = await team.suggest('related', { messageIds: c.contextIds, title: c.title }).catch(() => null)
    if (my !== seq) return
    judging.value = false
    related.value = r?.related || []
  }

  const has = (it) => chips.value.some((c) => (it.type === 'role' ? c.role === it.role : c.id === it.id))
  const hit = (it) => {
    const s = query.value.toLowerCase()
    if (!s) return true
    return [it.name, it.email, it.role, ...(it.roles || []), it.holder?.name].some((v) => v && String(v).toLowerCase().includes(s))
  }
  const sections = computed(() => {
    const f = fast.value
    if (!f) return []
    const rel = new Set(related.value.map((p) => p.id))
    const out = [
      { key: 'frequent', label: '자주 전달', items: f.frequent },
      { key: 'related', label: judging.value ? '이 일과 관련 · 찾는 중…' : '이 일과 관련', items: related.value, pending: judging.value },
      { key: 'roles', label: '역할', items: f.roles },
      { key: 'rest', label: '팀원', items: f.rest.filter((p) => !rel.has(p.id)) },
    ]
    return out.map((s) => ({ ...s, items: s.items.filter((it) => hit(it) && !has(it)) })).filter((s) => s.items.length || (s.pending && !query.value))
  })
  const flat = computed(() => sections.value.flatMap((s) => s.items))
  watch(flat, () => { if (active.value >= flat.value.length) active.value = 0 })

  function update() {
    const el = ta.value
    if (!el || !enabled) return
    const before = text.value.slice(0, el.selectionStart ?? text.value.length)
    const m = /(^|\s)@([^\s@]{0,20})$/.exec(before)
    if (!m) { close(); return }
    const wasOpen = open.value
    query.value = m[2]
    at.value = before.length - m[2].length - 1
    x.value = Math.max(0, Math.min(caretXY(el).x - 8, el.clientWidth - 300))
    open.value = true
    if (!wasOpen) { active.value = 0; load() }
  }
  function close() { open.value = false; query.value = ''; at.value = -1; seq++ ; judging.value = false }

  async function pick(it) {
    if (!it) return
    const label = it.type === 'role' ? `${it.role}` : it.name
    chips.value = [...chips.value, it.type === 'role' ? { type: 'role', role: it.role, label, holder: it.holder?.name } : { type: 'user', id: it.id, label }]
    // the "@que" typed so far goes; the chip stands for it
    const pos = at.value
    const end = pos + 1 + query.value.length
    text.value = text.value.slice(0, pos) + text.value.slice(end).replace(/^\s*/, '')
    close()
    await nextTick()
    ta.value?.focus()
    ta.value?.setSelectionRange(pos, pos)
  }
  const remove = (i) => { chips.value = chips.value.filter((_, k) => k !== i) }

  // true when the key was the list's
  function onKey(e) {
    if (!open.value) {
      // Backspace on an empty composer takes the last chip back
      if (e.key === 'Backspace' && !text.value && chips.value.length) { chips.value = chips.value.slice(0, -1); return true }
      return false
    }
    const n = flat.value.length
    if (e.key === 'ArrowDown' && n) { active.value = (active.value + 1) % n; e.preventDefault(); return true }
    if (e.key === 'ArrowUp' && n) { active.value = (active.value - 1 + n) % n; e.preventDefault(); return true }
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing && n) { e.preventDefault(); pick(flat.value[active.value]); return true }
    if (e.key === 'Escape') { close(); e.preventDefault(); return true }
    return false
  }

  const sending = ref(false)
  // the message goes to the chipped teammates (not to the agent), with this conversation's gist
  async function send(body) {
    if (!body?.trim() || sending.value) return false
    const objs = app.mentions || [] // document-object chips (@표 2), when the composer has them
    const objects = objs.length ? `${objs.map((m) => `@${m.label}`).join(' ')} ` : ''
    const to = chips.value.map((c) => (c.type === 'role' ? { type: 'role', role: c.role } : { type: 'user', id: c.id }))
    const c = context()
    sending.value = true
    try {
      const r = await team.mention({ to, text: objects + body, threadId: app.activeId, conversation: c.conversation, contextIds: c.contextIds, artifactIds: c.artifactIds })
      chips.value = []
      if (objs.length) app.mentions = []
      team.people = null
      team.say(`${r.sent.map((p) => p.name).join(', ')}님께 보냈어요${r.files ? ` · 산출물 ${r.files}개` : ''}`)
      return true
    } catch (e) {
      team.say(e.message || '보내지 못했어요.')
      return false
    } finally { sending.value = false }
  }

  const onUp = (e) => { if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(e.key)) update() }
  const onBlur = () => setTimeout(close, 150)
  onMounted(() => {
    team.boot()
    ta.value?.addEventListener('keyup', onUp)
    ta.value?.addEventListener('click', update)
    ta.value?.addEventListener('blur', onBlur)
  })
  onBeforeUnmount(() => {
    ta.value?.removeEventListener('keyup', onUp)
    ta.value?.removeEventListener('click', update)
    ta.value?.removeEventListener('blur', onBlur)
  })
  watch(text, () => nextTick(update))

  return { open, query, x, active, chips, sections, flat, judging, pick, remove, onKey, send, sending, close }
}
