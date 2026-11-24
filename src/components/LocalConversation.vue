<script setup>
// The run card's 「대화」 view (design docs/local-agents/design.md §5.11): the same CLI session as its terminal, as Lite's own conversation —
// built from the CLI's own records (Claude Code's session jsonl, Codex's rollout: desktop/src/runner/transcript.js), never from its
// screen. Whoever may watch the terminal sees it (the same exposure).
//   · a prompt with who put it in (「서하린 제안 · 윤태호 입력」 — the step's own prompt folded)
//   · the agent's words as markdown (safe — src/safeMarkdown.js), its thinking folded
//   · each tool call as one row: 「파일 읽음 · 견적서.md」, 「고침 · 견적서.md」 with its diff folded, 「명령 실행」 with its output folded,
//     「스킬 사용 · 견적-규칙」 …
//   · 「작업 중…」 while a turn runs
//   · what the CLI asks (a permission, a choice) as a card: only the CLI's owner presses a choice — the desktop presses the keys in its
//     terminal (prompts.js); everyone else sees 「<owner>님의 답을 기다려요」
// The input bar and the suggestions under it are the card's, shared with the terminal view.
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import { api } from '../api.js'
import { safeMarkdown } from '../safeMarkdown.js'
import { josa } from '../josa.js'

const props = defineProps({ relay: { type: Object, required: true }, run: { type: Object, required: true } })
const items = ref([])
const box = ref(null)
const open = ref({})       // folded rows opened by the viewer: id → true
const answering = ref('')  // the ask being answered (its press went out)
const picks = ref({})      // a choice per question of a several-question ask: askId → [index…]
const said = ref('')
const offs = []
const r = computed(() => props.run)
const live = computed(() => ['offered', 'running'].includes(r.value.state) && props.relay.st.state !== 'ended')
const owner = computed(() => !!props.relay.st.owner)
const person = computed(() => r.value.person || r.value.owner || '실행하는 사람')

onMounted(() => {
  const rl = props.relay
  offs.push(rl.on('tx', (m) => {
    const near = atBottom()
    if (m.replay) items.value = Array.isArray(m.items) ? m.items : []
    else items.value = [...items.value, ...(m.items || [])].slice(-2000)
    if (near) nextTick(toBottom)
  }))
  offs.push(rl.on('answer-failed', (m) => { if (answering.value === m.ask) answering.value = ''; said.value = m.reason === 'closed' ? '이미 답했거나 CLI 가 더는 묻지 않아요' : '데스크톱이 그 답을 넣지 못했어요' }))
  rl.subscribe(['tx'], { replay: true })
})
onBeforeUnmount(() => { for (const off of offs) off() })
function atBottom() { const el = box.value; return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
function toBottom() { const el = box.value; if (el) el.scrollTop = el.scrollHeight }

// ---------- what the items say ----------
const results = computed(() => { const m = new Map(); for (const it of items.value) if (it.t === 'result') m.set(it.call, it); return m })
const done = computed(() => new Set(items.value.filter((it) => it.t === 'ask-done').map((it) => it.ask)))
const lastTurn = computed(() => [...items.value].reverse().find((it) => it.t === 'turn') || null)
const working = computed(() => live.value && r.value.state === 'running' && (lastTurn.value ? lastTurn.value.state === 'start' : items.value.length > 0) && !openAsks.value.length)
const openAsks = computed(() => (live.value ? items.value.filter((it) => it.t === 'ask' && !done.value.has(it.ask?.id)) : []))
const steerOf = (id) => (r.value.steers || []).find((s) => s.id === id) || null
// who put a message in: the steer it was (its suggester and its worker), else the CLI's owner (typed in the terminal)
function whoOf(it) {
  const s = it.steerId ? steerOf(it.steerId) : null
  const from = s?.from || it.from
  const by = s?.name || it.by || person.value
  return from ? `${from} 제안 · ${by} 입력` : `${by} 입력`
}
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '')
const host = (u) => { try { return new URL(u).host } catch { return u } }
// a tool call, as Lite says it
function toolOf(it) {
  const i = it.input || {}
  const res = results.value.get(it.call)
  const n = it.name
  const map = {
    Read: ['파일 읽음', base(i.path)], Write: [res?.kind === 'update' ? '고쳐 씀' : '만듦', base(i.path)], Edit: ['고침', base(i.path)], MultiEdit: ['고침', base(i.path)],
    NotebookEdit: ['노트 고침', base(i.path)], apply_patch: ['고침', i.files?.length ? `${base(i.path)} 외 ${i.files.length - 1}개` : base(i.path)],
    Bash: ['명령 실행', i.description || i.command || ''], shell: ['명령 실행', ''], exec_command: ['명령 실행', ''], shell_command: ['명령 실행', ''], local_shell: ['명령 실행', ''],
    Skill: ['스킬 사용', i.skill || ''], Grep: ['찾음', i.pattern || ''], Glob: ['파일 찾음', i.pattern || ''], WebFetch: ['웹 읽음', host(i.url || '')],
    WebSearch: ['웹 검색', i.query || ''], web_search: ['웹 검색', i.query || ''], TodoWrite: ['할 일 정리', ''], update_plan: ['할 일 정리', ''],
    Task: ['하위 에이전트', i.description || ''], Agent: ['하위 에이전트', i.description || ''], AskUserQuestion: ['물음', i.questions?.[0]?.question || ''],
    ToolSearch: ['도구 찾음', ''], ExitPlanMode: ['계획', ''],
  }
  const [label, target] = map[n] || [n, i.path ? base(i.path) : i.command || '']
  return { label, target, res, state: res ? (res.ok === false ? 'bad' : 'ok') : live.value ? 'run' : 'gone' }
}
// the lines of a diff: the CLI's own patch, else the edit's old and new text
function diffOf(it) {
  const res = results.value.get(it.call)
  const patch = res?.patch || it.patch
  if (patch?.length) return patch.flatMap((h, k) => [...(k ? [{ t: 'h', s: '⋯' }] : []), ...h.lines.map((l) => ({ t: l.startsWith('@@') ? 'h' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx', s: l.startsWith('@@') ? l : l.slice(1) }))])
  const i = it.input || {}
  const edits = i.edits?.length ? i.edits : i.old != null || i.new != null ? [{ old: i.old || '', new: i.new || '' }] : []
  return edits.flatMap((e, k) => [...(k ? [{ t: 'h', s: '⋯' }] : []), ...String(e.old).split('\n').filter((x, j, a) => x || a.length > 1).map((s) => ({ t: 'del', s })), ...String(e.new).split('\n').map((s) => ({ t: 'add', s }))])
}
const hasDetail = (it) => {
  const i = it.input || {}
  const res = results.value.get(it.call)
  return !!(diffOf(it).length || i.content || i.command || res?.out || i.todos?.length || res?.answers || i.questions?.length)
}
const firstLines = (t, n = 2) => { const ls = String(t || '').split('\n').filter((l) => l.trim()); return ls.slice(0, n).join('\n') + (ls.length > n ? ' …' : '') }
const toggle = (id) => { open.value = { ...open.value, [id]: !open.value[id] } }
const md = (t) => safeMarkdown(t)

// the rows shown: the conversation without its bookkeeping (results go with their call; turns and answered asks are not rows)
const rows = computed(() => items.value.filter((it) => ['user', 'text', 'thinking', 'tool', 'note'].includes(it.t) || (it.t === 'ask' && !done.value.has(it.ask?.id) && live.value)))

// ---------- the owner answers what the CLI asks ----------
const toolWord = (t) => ({ Bash: '명령 실행', Write: '파일 쓰기', Edit: '파일 고치기', MultiEdit: '파일 고치기', WebFetch: '웹 읽기', WebSearch: '웹 검색' }[t] || t)
async function answer(ask, value) {
  if (!owner.value || answering.value) return
  answering.value = ask.id; said.value = ''
  try { await api(`/local-agents/jobs/${encodeURIComponent(r.value.jobId)}/answer`, { method: 'POST', body: { ask: ask.id, answer: value } }) }
  catch (e) { answering.value = ''; said.value = e.message }
}
function pick(ask, q, k) {
  const cur = [...(picks.value[ask.id] || Array(ask.questions.length).fill(null))]
  cur[q] = k
  picks.value = { ...picks.value, [ask.id]: cur }
  if (ask.questions.length === 1) answer(ask, [k])
}
const allPicked = (ask) => (picks.value[ask.id] || []).filter((x) => x != null).length === ask.questions.length
watch(done, (d) => { if (answering.value && d.has(answering.value)) answering.value = '' })
</script>

<template>
  <div class="cv" data-test="local-run-conversation" :data-working="working ? 'yes' : 'no'">
    <div ref="box" class="scroller">
      <p v-if="!rows.length" class="empty" data-test="local-run-conv-empty">{{ relay.st.state === 'connecting' ? '대화를 불러오는 중…' : live ? 'CLI 가 시작하기를 기다려요' : '남은 대화가 없어요' }}</p>
      <template v-for="it in rows" :key="it.id">
        <!-- a message the CLI took: who put it in -->
        <div v-if="it.t === 'user'" class="msg user" :class="{ first: it.first, cmd: it.cmd }" data-test="local-run-conv-user" :data-steer="it.steerId || ''">
          <small class="who" data-test="local-run-conv-who">{{ it.first ? '단계 프롬프트' : it.cmd ? `${person} · 명령` : whoOf(it) }}</small>
          <div v-if="it.first" class="bubble fold">
            <pre class="plain">{{ open[it.id] ? it.text : firstLines(it.text) }}</pre>
            <button type="button" class="lnk" @click="toggle(it.id)">{{ open[it.id] ? '접기' : '펼치기' }}</button>
          </div>
          <div v-else class="bubble"><pre class="plain">{{ it.text }}</pre></div>
        </div>
        <!-- what the agent said -->
        <div v-else-if="it.t === 'text'" class="msg agent md" data-test="local-run-conv-text" v-html="md(it.text)" />
        <!-- its thinking, folded -->
        <div v-else-if="it.t === 'thinking'" class="think" data-test="local-run-conv-thinking">
          <button type="button" class="row-btn" :aria-expanded="!!open[it.id]" @click="toggle(it.id)"><span class="caret" :class="{ on: open[it.id] }">›</span> 생각</button>
          <p v-if="open[it.id]" class="think-tx">{{ it.text }}</p>
        </div>
        <!-- a tool call: one row, its detail folded -->
        <div v-else-if="it.t === 'tool'" class="tool" :class="toolOf(it).state" data-test="local-run-conv-tool" :data-tool="it.name" :data-tool-state="toolOf(it).state">
          <button type="button" class="row-btn" :disabled="!hasDetail(it)" :aria-expanded="!!open[it.id]" data-test="local-run-conv-tool-open" @click="toggle(it.id)">
            <span class="dot" />
            <b class="lbl">{{ toolOf(it).label }}</b><span v-if="toolOf(it).target" class="tgt">{{ ` · ${toolOf(it).target}` }}</span>
            <span v-if="hasDetail(it)" class="caret" :class="{ on: open[it.id] }">›</span>
          </button>
          <div v-if="open[it.id]" class="detail" data-test="local-run-conv-detail">
            <code v-if="it.input?.command" class="cmdline">$ {{ it.input.command }}</code>
            <div v-if="diffOf(it).length" class="diff" data-test="local-run-conv-diff">
              <div v-for="(l, k) in diffOf(it)" :key="k" class="dl" :class="l.t"><span class="sg">{{ l.t === 'add' ? '+' : l.t === 'del' ? '−' : '' }}</span><span class="ln">{{ l.s }}</span></div>
            </div>
            <pre v-else-if="it.input?.content" class="out">{{ it.input.content }}</pre>
            <ul v-if="it.input?.todos?.length" class="todos"><li v-for="(t, k) in it.input.todos" :key="k" :class="t.state">{{ t.text }}</li></ul>
            <ul v-if="toolOf(it).res?.answers" class="todos"><li v-for="(v, q) in toolOf(it).res.answers" :key="q">{{ q }} → <b>{{ v }}</b></li></ul>
            <pre v-if="toolOf(it).res?.out && !diffOf(it).length" class="out" :class="{ bad: toolOf(it).res.ok === false }">{{ toolOf(it).res.out }}</pre>
          </div>
        </div>
        <p v-else-if="it.t === 'note'" class="note" :class="it.kind" data-test="local-run-conv-note">{{ it.kind === 'interrupted' ? '멈춤 — 이번 턴을 멈췄어요' : it.text }}</p>
        <!-- what the CLI asks: the owner answers here (or in the terminal), everyone else waits for them -->
        <div v-else-if="it.t === 'ask'" class="ask" data-test="local-run-ask" :data-ask="it.ask.id" :data-ask-kind="it.ask.kind">
          <template v-if="it.ask.kind === 'permission'">
            <b class="q">{{ toolWord(it.ask.tool) }}{{ josa(toolWord(it.ask.tool), '을', '를') }} 허락할까요?</b>
            <small v-if="it.ask.description" class="sub">{{ it.ask.description }}</small>
            <code v-if="it.ask.brief" class="cmdline">{{ it.ask.brief }}</code>
            <div v-if="owner" class="choices">
              <button v-for="c in it.ask.choices" :key="c" type="button" class="choice press" :class="c" :disabled="!!answering" :data-choice="c" data-test="local-run-ask-choice" @click="answer(it.ask, c)">
                {{ { yes: '허락', always: '허락 — 앞으로 묻지 않기', no: '거절' }[c] }}
              </button>
            </div>
          </template>
          <template v-else>
            <div v-for="(q, qi) in it.ask.questions" :key="qi" class="qq">
              <b class="q">{{ q.question }}</b>
              <div v-if="owner" class="choices col">
                <button v-for="(o, k) in q.options" :key="k" type="button" class="choice opt press" :class="{ on: (picks[it.ask.id] || [])[qi] === k }" :disabled="!!answering" :data-choice="k" data-test="local-run-ask-choice" @click="pick(it.ask, qi, k)">
                  <span>{{ o.label }}</span><small v-if="o.description">{{ o.description }}</small>
                </button>
              </div>
              <ul v-else class="opts"><li v-for="(o, k) in q.options" :key="k">{{ o.label }}</li></ul>
            </div>
            <button v-if="owner && it.ask.questions.length > 1" type="button" class="choice yes press" :disabled="!!answering || !allPicked(it.ask)" data-test="local-run-ask-send" @click="answer(it.ask, picks[it.ask.id])">답 보내기</button>
          </template>
          <small v-if="!owner" class="wait" data-test="local-run-ask-wait">{{ person }}님의 답을 기다려요</small>
          <small v-else-if="answering === it.ask.id" class="wait">터미널에 답을 넣는 중…</small>
        </div>
      </template>
      <p v-if="working" class="working" data-test="local-run-working"><span class="spin" /> 작업 중…</p>
    </div>
    <p v-if="said" class="said" data-test="local-run-conv-said">{{ said }}</p>
  </div>
</template>

<style scoped>
.cv { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.scroller { max-height: 460px; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px; border-radius: 14px;
  background: var(--field-bg); border: 1px solid var(--hairline); min-width: 0; overscroll-behavior: contain; }
.empty { margin: 6px 0; color: var(--text-secondary); font-size: 13px; }
.msg { min-width: 0; max-width: 100%; }
.msg.user { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
.who { color: var(--text-secondary); font-size: 11.5px; }
.bubble { max-width: 92%; padding: 8px 11px; border-radius: 14px 14px 4px 14px; background: var(--chip-bg); box-shadow: 0 1px 0 var(--hairline); min-width: 0; }
.first .bubble { background: transparent; border: 1px dashed var(--hairline); border-radius: 12px; max-width: 100%; }
.cmd .bubble { font-family: "SF Mono", Menlo, monospace; }
.plain { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 13.5px; line-height: 1.5; }
.first .plain { color: var(--text-secondary); font-size: 12.5px; }
.lnk { color: var(--color-info); font-size: 12px; background: none; padding: 0; margin-top: 2px; }
.md { font-size: 14px; line-height: 1.6; overflow-wrap: anywhere; }
.md :deep(p) { margin: 0 0 6px; } .md :deep(p:last-child) { margin-bottom: 0; }
.md :deep(ul), .md :deep(ol) { margin: 2px 0 6px; padding-left: 20px; }
.md :deep(code) { font: 12.5px "SF Mono", Menlo, monospace; background: var(--button-bg); padding: 1px 5px; border-radius: 6px; }
.md :deep(pre) { margin: 4px 0; padding: 8px 10px; border-radius: 10px; background: var(--button-bg); overflow-x: auto; max-width: 100%; }
.md :deep(pre code) { background: none; padding: 0; }
.md :deep(table) { border-collapse: collapse; display: block; overflow-x: auto; max-width: 100%; font-size: 13px; }
.md :deep(th), .md :deep(td) { border: 1px solid var(--hairline); padding: 3px 8px; }
.md :deep(a) { color: var(--color-info); }
.md :deep(blockquote) { margin: 4px 0; padding-left: 10px; border-left: 3px solid var(--hairline); color: var(--text-secondary); }
.row-btn { display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; text-align: left; padding: 4px 2px; border-radius: 8px; font-size: 13px; color: var(--text-primary); }
.row-btn:disabled { cursor: default; }
.think .row-btn { color: var(--text-secondary); font-size: 12.5px; }
.think-tx { margin: 2px 0 0 16px; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text-secondary); font-size: 12.5px; line-height: 1.55; }
.caret { display: inline-block; transition: transform .15s; color: var(--text-tertiary); flex: none; } .caret.on { transform: rotate(90deg); }
.tool { min-width: 0; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--color-success); flex: none; }
.tool.run .dot { background: var(--color-info); animation: pulse 1.2s ease-in-out infinite; }
.tool.bad .dot { background: var(--color-error); }
.tool.gone .dot { background: var(--text-tertiary); }
.lbl { font-weight: 600; flex: none; }
.tgt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); font-family: "SF Mono", Menlo, monospace; font-size: 12.5px; }
.tool .caret { margin-left: auto; }
.detail { margin: 2px 0 4px 13px; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.cmdline { display: block; font: 12px/1.5 "SF Mono", Menlo, monospace; padding: 6px 9px; border-radius: 9px; background: var(--button-bg); overflow-x: auto; white-space: pre; max-width: 100%; }
/* a diff scrolls inside itself (a phone keeps its width) */
.diff { max-height: 260px; overflow: auto; border-radius: 10px; border: 1px solid var(--hairline); font: 12px/1.6 "SF Mono", Menlo, monospace; max-width: 100%; background: var(--regular-solid-bg); }
.dl { display: flex; white-space: pre; min-width: max-content; padding-right: 10px; }
.dl .sg { flex: none; width: 18px; text-align: center; color: var(--text-tertiary); user-select: none; }
.dl.add { background: rgba(15 157 88 / .14); } .dl.add .sg { color: var(--color-success); }
.dl.del { background: rgba(214 69 69 / .14); } .dl.del .sg { color: var(--color-error); }
.dl.h { color: var(--text-tertiary); }
.out { margin: 0; max-height: 220px; overflow: auto; padding: 7px 10px; border-radius: 10px; background: var(--button-bg); font: 12px/1.5 "SF Mono", Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-width: 100%; }
.out.bad { color: var(--color-error); }
.todos { margin: 0; padding-left: 18px; font-size: 13px; } .todos .completed { text-decoration: line-through; color: var(--text-secondary); }
.note { margin: 0; font-size: 12.5px; color: var(--text-secondary); } .note.error { color: var(--color-error); }
.ask { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 16px; background: var(--regular-solid-bg); border: 1.5px solid color-mix(in srgb, var(--color-info) 55%, transparent);
  box-shadow: var(--shadow-card); min-width: 0; }
.q { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.sub { color: var(--text-secondary); font-size: 12.5px; }
.qq { display: flex; flex-direction: column; gap: 6px; }
.choices { display: flex; flex-wrap: wrap; gap: 6px; } .choices.col { flex-direction: column; }
.choice { min-height: 34px; padding: 6px 14px; border-radius: 17px; background: var(--button-bg); color: var(--text-primary); font-size: 13.5px; text-align: left; display: flex; flex-direction: column; gap: 1px; }
.choice.yes { background: var(--ink); color: var(--ink-inverse); align-self: flex-start; }
.choice.no { color: var(--color-error); }
.choice.opt { border-radius: 12px; border: 1px solid var(--hairline); } .choice.opt.on { border-color: var(--color-info); }
.choice small { color: var(--text-secondary); font-size: 12px; }
.choice:disabled { opacity: .45; }
.opts { margin: 0; padding-left: 18px; font-size: 13px; color: var(--text-secondary); }
.wait { color: var(--text-secondary); font-size: 12.5px; }
.working { margin: 0; display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 13px; }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; flex: none; }
.said { margin: 0; font-size: 12px; color: var(--color-error); }
@media (max-width: 760px) { .scroller { max-height: 62vh; padding: 8px 10px; } .bubble { max-width: 96%; } }
</style>
