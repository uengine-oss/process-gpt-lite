<script setup>
// 들어온 메일이 어느 일부터 시작하는지(server lib/ontology/run.js routeMail):
// started — 고른 일과 확률, 평소 흐름에서 건너뛴 일 · 이번 스냅샷의 일, 「건 보기」 · 「다른 일에서 시작」
// ask — 모델이 확실하지 않을 때(가장 높은 확률이 50% 아래) 두세 후보 중에서 사람이 고른다
// ask + suggest — 아직 「제안」 단계인 프로세스(자동으로 승격 전): 이 메일 · 채팅 요청으로 그 프로세스를 진행할지 묻는다(design-v0.3 §12)
// choices — 한 사건이 여러 프로세스의 일일 때(server events.js: 프로세스마다 따로 읽음): 프로세스마다 시작할 일을 보이고 하나씩 진행한다
// source file — 채팅에 올린 파일이 사건일 때: 파일 이름과 함께 묻기만 한다(사람이 올렸으므로 저절로 시작하지 않는다)
// 서버는 이 카드 내용을 바꾸지 않으므로, 고른 결과 · 옮긴 결과는 이 기기에 남겨 다시 열어도 그대로 보인다.
import { ref, computed } from 'vue'
import { api } from '../../api.js'
import { pct } from './fmt.js'
import OntoSheet from './OntoSheet.vue'
import OntoCasePanel from './OntoCasePanel.vue'
import OntoBindings from './OntoBindings.vue'
import { local, RO, EUN, entryManyText } from './ontoText.js'

const props = defineProps({ msg: Object })
const saved = ref(local.get(`entry:${props.msg.id}`))
const v = computed(() => ({ ...(props.msg.content || {}), ...(saved.value || {}) }))
const choice = computed(() => v.value.choice || {})
const task = computed(() => choice.value.task || v.value.nodes?.[0] || '')
const chat = computed(() => v.value.source === 'chat')
const timer = computed(() => v.value.source === 'timer')
const fileEv = computed(() => v.value.source === 'file')
const who = computed(() => {
  if (chat.value) return '이 요청은'
  if (fileEv.value) return '올린 파일은'
  if (timer.value) return `${v.value.when || '정해 둔 시각'} 타이머가 울렸어요.`
  const s = String(v.value.customer || '').trim()
  return s && !s.includes('@') ? `${s} 메일은` : '이 메일은'
})
const pText = (p, measured = choice.value.measured) => (measured === false ? '모델이 고름' : pct(p))
const options = computed(() => (choice.value.options || []).slice(0, 3))
const skipped = computed(() => v.value.skipped || [])
const after = computed(() => (v.value.nodes || []).filter((k) => k !== task.value))
const err = ref('')
const busy = ref('')
const persist = (patch) => { saved.value = { ...(saved.value || {}), ...patch }; local.set(`entry:${props.msg.id}`, saved.value) }

// ask → 고르면 건을 시작한다(ch: 여러 프로세스 중 고른 프로세스의 choice — 하나뿐이면 그 choice)
const kindOf = () => (chat.value ? 'chat' : timer.value ? 'timer' : fileEv.value ? 'file' : 'mail')
async function start(o, ch = choice.value) {
  busy.value = `${ch.proc}:${o.task}`; err.value = ''
  const m = v.value.mail || {}
  try {
    const r = await api('/ontology/cases', { method: 'POST', body: {
      proc: ch.proc, entry: o.task, subject: m.subject || '', body: m.text || '', from: m.from || '', customer: v.value.customer || '',
      odds: { ...ch, task: o.task, p: o.p, picked: true }, kind: kindOf(), ...(v.value.file ? { file: v.value.file } : {}), messageId: props.msg.id,
      picks: picks.value[ch.proc] || [],
    } })
    if (many.value) { persist({ starts: { ...(v.value.starts || {}), [ch.proc]: { caseId: r.caseId, task: o.task, engine: r.engine || 'bpm' } } }); return }
    persist({ state: 'started', picked: !ch.suggest || o.task !== ch.task, choice: { ...ch, task: o.task, p: o.p }, caseId: r.caseId, instId: r.instId,
      skipped: r.snapshot?.skipped || [], nodes: r.snapshot?.nodes || [o.task], procDefId: r.snapshot?.procDefId, bindings: r.bindings || null })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
// 맡는 사람(OntoBindings · server bindings.js): 진행하기 전에 역할마다 누가 맡는지 보고 바꾼다 — 여러 명이거나 아무도 없는 역할은 골라야 진행
const picks = ref({}) // proc → [{role, userId}]
const ready = ref({}) // proc → false while a role has nobody
const canStart = (ch = choice.value) => ready.value[ch.proc] !== false
// 여러 프로세스: 프로세스마다 가장 그럴듯한 시작 일과 다른 후보
const many = computed(() => (v.value.choices || []).length > 1)
// the same event already started an adopted process (its own card is just above): counted, and said apart from what is offered here
const startedAlso = computed(() => v.value.startedAlso || [])
const manyText = computed(() => entryManyText(who.value, (v.value.choices || []).length, startedAlso.value.length))
const topOf = (ch) => (ch.options || [])[0] || { task: ch.task, p: ch.p }
const startedOf = (ch) => (v.value.starts || {})[ch.proc] || null
const caseOpen = ref('')

// started → 다른 일에서 시작(옮기기)
const menu = ref(false)
const target = ref('')
const reason = ref('')
const others = computed(() => {
  const seen = new Set([task.value])
  const list = []
  for (const o of options.value) if (!seen.has(o.task)) { seen.add(o.task); list.push({ task: o.task, p: o.p }) }
  for (const k of [...skipped.value, ...after.value]) if (!seen.has(k)) { seen.add(k); list.push({ task: k }) }
  return list
})
async function move() {
  if (!target.value) return
  busy.value = 'move'; err.value = ''
  const from = task.value
  try {
    const r = await api(`/ontology/cases/${encodeURIComponent(v.value.caseId)}/move`, { method: 'POST', body: { task: target.value, reason: reason.value.trim() || '메일 카드에서 다른 일 선택', messageId: props.msg.id } })
    const p = options.value.find((o) => o.task === target.value)?.p ?? null
    persist({ choice: { ...choice.value, task: target.value, p }, movedFrom: from, instId: r.instId, skipped: r.snapshot?.skipped || [], nodes: r.snapshot?.nodes || [target.value], procDefId: r.snapshot?.procDefId })
    menu.value = false; target.value = ''; reason.value = ''
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const sheet = ref(false)
const decline = () => persist({ state: 'declined' })
const top = computed(() => options.value[0] || { task: choice.value.task, p: choice.value.p })
</script>

<template>
  <div class="oe" data-testid="onto-entry-card" :data-state="v.state">
    <div class="mail">
      <span class="badge">{{ chat ? '채팅' : timer ? '타이머' : fileEv ? '파일' : '메일' }}</span>
      <span class="ms" :title="`${v.mail?.from || ''} · ${v.mail?.subject || ''}`">{{ v.mail?.subject || '(제목 없음)' }}</span>
    </div>

    <!-- 한 사건이 여러 프로세스의 일: 프로세스마다 묻는다(자동인 프로세스는 이미 시작한 건이 따로 카드로 와요) -->
    <template v-if="v.state === 'ask' && many">
      <p class="q" data-testid="onto-entry-many" :data-count="v.choices.length" :data-total="v.choices.length + startedAlso.length">{{ manyText }}</p>
      <p v-if="v.mail?.text && !timer" class="ex">{{ v.mail.text }}</p>
      <small v-for="x in v.startedAlso || []" :key="x.proc" class="okline" data-testid="onto-entry-started-also">「{{ x.procName }}」{{ EUN(x.procName) }} 자동이라 「{{ x.task }}」부터 이미 시작했어요.</small>
      <div v-for="ch in v.choices" :key="ch.proc" class="pc" data-testid="onto-entry-proc" :data-proc="ch.proc" :data-started="startedOf(ch) ? '1' : '0'">
        <b class="pn">{{ ch.procName }}<small v-if="ch.procP != null"> · {{ pText(ch.procP, true) }}</small><small v-if="!ch.suggest" class="adopted"> · 자동</small></b>
        <template v-if="startedOf(ch)">
          <small class="okline" data-testid="onto-entry-proc-started">「{{ startedOf(ch).task }}」부터 시작했어요 · <button class="link press" @click="caseOpen = startedOf(ch).caseId">건 보기</button></small>
        </template>
        <OntoBindings v-if="!startedOf(ch)" :proc="ch.proc" :entry="topOf(ch).task" compact @picks="(p) => (picks = { ...picks, [ch.proc]: p })" @ready="(r) => (ready = { ...ready, [ch.proc]: r })" />
        <div v-if="!startedOf(ch)" class="opts">
          <button class="opt press" :disabled="!!busy || !canStart(ch)" data-testid="onto-entry-go" @click="start(topOf(ch), ch)">
            <i :style="{ width: `${Math.max(3, Math.round((topOf(ch).p || 0) * 100))}%` }" />
            <span class="on">{{ busy === `${ch.proc}:${topOf(ch).task}` ? '시작하는 중…' : `「${topOf(ch).task}」부터 진행` }}</span><b>{{ pText(topOf(ch).p, ch.measured) }}</b>
          </button>
          <button v-for="o in (ch.options || []).slice(1, 3)" :key="o.task" class="opt sm press" :disabled="!!busy || !canStart(ch)" data-testid="onto-entry-option" @click="start(o, ch)">
            <span class="on">{{ busy === `${ch.proc}:${o.task}` ? '시작하는 중…' : `「${o.task}」부터` }}</span><b>{{ pText(o.p, ch.measured) }}</b>
          </button>
        </div>
      </div>
      <button class="link press" :disabled="!!busy" data-testid="onto-entry-decline" @click="decline">아니요, 이번엔 그냥 할게요</button>
      <small class="why">{{ fileEv || chat ? '사람이 올린 것이라 저절로 시작하지 않고 물어봐요.' : '「제안」 단계인 업무라 물어봐요. 관리자가 「자동으로 승격」하면 같은 요청이 오면 바로 시작해요.' }}</small>
    </template>

    <!-- 아직 「제안」 단계인 프로세스: 진행할지 묻는다 -->
    <template v-else-if="v.state === 'ask' && choice.suggest">
      <p class="q" data-testid="onto-entry-suggest">{{ who }} 「{{ choice.procName }}」 업무로 진행할 수 있어요. 「{{ top.task }}」부터 시작할까요?</p>
      <small v-for="x in v.startedAlso || []" :key="x.proc" class="okline" data-testid="onto-entry-started-also">「{{ x.procName }}」{{ EUN(x.procName) }} 자동이라 「{{ x.task }}」부터 이미 시작했어요.</small>
      <p v-if="v.mail?.text && !chat && !timer" class="ex">{{ v.mail.text }}</p>
      <small v-if="fileEv" class="why" data-testid="onto-entry-file">올린 파일 · {{ v.file?.name || v.mail?.subject }}</small>
      <OntoBindings :proc="choice.proc" :entry="top.task" @picks="(p) => (picks = { ...picks, [choice.proc]: p })" @ready="(r) => (ready = { ...ready, [choice.proc]: r })" />
      <div class="opts">
        <button class="opt press" :disabled="!!busy || !canStart()" data-testid="onto-entry-go" @click="start(top)">
          <i :style="{ width: `${Math.max(3, Math.round((top.p || 0) * 100))}%` }" />
          <span class="on">{{ busy === `${choice.proc}:${top.task}` ? '시작하는 중…' : `「${top.task}」부터 진행` }}</span><b>{{ pText(top.p) }}</b>
        </button>
        <button v-for="o in options.slice(1)" :key="o.task" class="opt press" :disabled="!!busy || !canStart()" data-testid="onto-entry-option" @click="start(o)">
          <i :style="{ width: `${Math.max(3, Math.round((o.p || 0) * 100))}%` }" />
          <span class="on">{{ busy === `${choice.proc}:${o.task}` ? '시작하는 중…' : `「${o.task}」부터` }}</span><b>{{ pText(o.p) }}</b>
        </button>
        <button class="link press" :disabled="!!busy" data-testid="onto-entry-decline" @click="decline">아니요, 이번엔 그냥 할게요</button>
      </div>
      <small class="why">이 프로세스는 아직 「제안」 단계라 물어봐요 — 시작한 뒤에도 단계마다 사람이 정해요. 관리자가 「자동으로 승격」하면 같은 요청이 오면 바로 시작해요.</small>
    </template>
    <template v-else-if="v.state === 'declined'">
      <p class="q" data-testid="onto-entry-declined">이번 요청은 프로세스 없이 진행해요.</p>
    </template>
    <!-- 확실하지 않을 때: 사람이 고른다 -->
    <template v-else-if="v.state === 'ask'">
      <p class="q">{{ who }} 어디서 시작할지 확실하지 않아요. 어느 일부터 할까요?</p>
      <p v-if="v.mail?.text" class="ex">{{ v.mail.text }}</p>
      <OntoBindings v-if="options[0]" :proc="choice.proc" :entry="options[0].task" @picks="(p) => (picks = { ...picks, [choice.proc]: p })" @ready="(r) => (ready = { ...ready, [choice.proc]: r })" />
      <div class="opts">
        <button v-for="o in options" :key="o.task" class="opt press" :disabled="!!busy || !canStart()" data-testid="onto-entry-option" @click="start(o)">
          <i :style="{ width: `${Math.max(3, Math.round((o.p || 0) * 100))}%` }" />
          <span class="on">{{ busy === `${choice.proc}:${o.task}` ? '시작하는 중…' : o.task }}</span><b>{{ pText(o.p) }}</b>
        </button>
      </div>
      <small v-if="choice.procName" class="why">「{{ choice.procName }}」 흐름의 일 중에서 골랐어요.</small>
    </template>

    <!-- 시작함 -->
    <template v-else>
      <p class="q" data-testid="onto-entry-text">
        <template v-if="v.movedFrom">「{{ v.movedFrom }}」 대신 「{{ task }}」부터 하고 있어요.</template>
        <template v-else-if="v.picked">「{{ task }}」부터 시작했어요.</template>
        <template v-else>{{ who }} <template v-if="choice.procName">「{{ choice.procName }}」의 </template>「{{ task }}」부터 시작할게요 <span class="p">({{ pText(choice.p) }})</span></template>
      </p>
      <ol class="strip" aria-label="이번 건의 일">
        <li v-if="skipped.length" class="lbl">건너뜀</li>
        <li v-for="k in skipped" :key="`s-${k}`" class="st skip" :title="`${k} · 건너뜀`"><span class="nm">{{ k }}</span></li>
        <li class="st here"><span class="nm">{{ task }}</span><small>여기부터</small></li>
        <li v-for="k in after" :key="`n-${k}`" class="st"><span class="nm">{{ k }}</span></li>
      </ol>
      <small v-if="options.length > 1 && !v.movedFrom" class="odds" data-testid="onto-entry-odds">
        <template v-for="(o, i) in options" :key="o.task"><template v-if="i"> · </template><span :class="{ top: o.task === task }">{{ o.task }} {{ pText(o.p) }}</span></template>
      </small>
      <OntoBindings v-if="v.caseId && v.bindings?.length" :bindings="v.bindings" :case-id="v.caseId" @changed="(b) => persist({ bindings: b })" />
      <div class="foot">
        <button v-if="v.caseId" class="link press" data-testid="onto-entry-case" @click="sheet = true">건 보기</button>
        <button v-if="v.caseId && others.length" class="link sub press" :aria-expanded="menu" data-testid="onto-entry-move" @click="menu = !menu; target = ''">다른 일에서 시작</button>
      </div>
      <div v-if="menu" class="menu" data-testid="onto-entry-menu">
        <div class="ml scroll">
          <button v-for="o in others" :key="o.task" class="mi press" :class="{ on: target === o.task }" @click="target = o.task">
            <span>{{ o.task }}</span><small v-if="o.p != null">{{ pText(o.p) }}</small>
          </button>
        </div>
        <div v-if="target" class="confirm">
          <input v-model="reason" class="in" placeholder="옮기는 이유(선택)" maxlength="200" />
          <div class="btns">
            <button class="ghost press" :disabled="!!busy" @click="target = ''">취소</button>
            <button class="go press" :disabled="!!busy" data-testid="onto-entry-move-apply" @click="move">{{ busy === 'move' ? '옮기는 중…' : `「${target}」${RO(target)} 옮기기` }}</button>
          </div>
        </div>
      </div>
    </template>
    <small v-if="err" class="err">{{ err }}</small>

    <OntoSheet v-if="caseOpen" title="건" @close="caseOpen = ''">
      <OntoCasePanel :case-id="caseOpen" />
    </OntoSheet>
    <OntoSheet v-if="sheet" title="건" @close="sheet = false">
      <OntoCasePanel :case-id="v.caseId" @moved="(r) => persist({ instId: r.instId, nodes: r.snapshot?.nodes || [], skipped: r.snapshot?.skipped || [], movedFrom: task, choice: { ...choice, task: r.snapshot?.nodes?.[0] || task, p: null } })" />
    </OntoSheet>
  </div>
</template>

<style scoped>
.oe { word-break: keep-all; overflow-wrap: anywhere; width: 424px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; padding: 14px 16px; border-radius: 24px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); min-width: 0; }
.mail { display: flex; align-items: center; gap: 8px; min-width: 0; }
.badge { flex: none; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.ms { min-width: 0; font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.q { margin: 0; font-size: 15.5px; line-height: 1.55; word-break: keep-all; overflow-wrap: anywhere; }
.p { color: var(--color-info); font-weight: 600; white-space: nowrap; }
.ex { margin: 2px 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); padding: 0 0 0 12px; border-left: 2px solid var(--hairline); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.opts { display: flex; flex-direction: column; gap: 6px; }
.opt { position: relative; isolation: isolate; overflow: hidden; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 0 14px; border-radius: 14px; background: var(--field-bg); text-align: left; }
.opt i { position: absolute; left: 0; top: 0; bottom: 0; z-index: -1; background: color-mix(in srgb, var(--color-info) 18%, transparent); }
.opt .on { flex: 1; min-width: 0; font-size: 14.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.opt b { flex: none; font-size: 13.5px; font-weight: 600; color: var(--color-info); font-variant-numeric: tabular-nums; }
.opt:disabled { opacity: .6; }
.why { font-size: 12px; color: var(--text-tertiary); }
.pc { display: flex; flex-direction: column; gap: 6px; padding: 10px; border-radius: 16px; background: var(--cell-bg); }
.pn { font-size: 14px; font-weight: 600; line-height: 1.4; }
.pn small { font-weight: 500; color: var(--text-secondary); }
.pn .adopted { color: var(--color-info); }
.opt.sm { min-height: 36px; }
.opt.sm .on { font-size: 13.5px; }
.okline { font-size: 13px; color: var(--color-success); }
.strip { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 2px; }
.st { position: relative; display: inline-flex; align-items: center; gap: 5px; max-width: calc(100% - 14px); padding: 4px 10px; border-radius: 9999px; background: var(--field-bg); font-size: 13px; min-width: 0; }
.st:not(:first-child) { margin-left: 14px; }
.st:not(:first-child)::before { content: '›'; position: absolute; left: -11px; color: var(--text-tertiary); font-weight: 400; }
.lbl { font-size: 11.5px; color: var(--text-tertiary); margin-right: 2px; }
.lbl + .st { margin-left: 4px; } .lbl + .st::before { content: none; }
.st .nm { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.st small { flex: none; font-size: 10.5px; color: var(--text-tertiary); }
.st.skip { color: var(--text-tertiary); background: transparent; box-shadow: inset 0 0 0 1px var(--hairline); }
.st.skip .nm { text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--text-tertiary) 70%, transparent); }
.st.here { background: var(--ink); color: var(--ink-inverse); font-weight: 600; }
.st.here small { color: color-mix(in srgb, var(--ink-inverse) 60%, transparent); font-weight: 500; }
.odds { font-size: 12px; color: var(--text-tertiary); line-height: 1.5; }
.odds .top { color: var(--text-secondary); font-weight: 600; }
.foot { display: flex; gap: 14px; align-items: center; }
.link { font-size: 13.5px; font-weight: 500; color: var(--color-info); }
.link.sub { color: var(--text-secondary); font-weight: 400; text-decoration: underline; text-decoration-color: var(--hairline); text-underline-offset: 3px; }
.menu { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 16px; background: var(--cell-bg); }
.ml { display: flex; flex-direction: column; gap: 2px; max-height: 196px; overflow-y: auto; }
.mi { flex: none; display: flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px; border-radius: 10px; font-size: 14px; text-align: left; }
.mi span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mi small { flex: none; font-size: 12px; color: var(--text-secondary); }
.mi:hover { background: var(--field-bg); }
.mi.on { background: var(--field-bg); box-shadow: inset 0 0 0 1.5px var(--text-secondary); }
.confirm { display: flex; flex-direction: column; gap: 6px; padding: 6px 4px 2px; }
.in { width: 100%; min-width: 0; height: 36px; padding: 0 10px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font-size: 14px; }
.in::placeholder { color: var(--text-tertiary); }
.btns { display: flex; justify-content: flex-end; gap: 6px; flex-wrap: wrap; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.go { height: 34px; max-width: 100%; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go:disabled, .ghost:disabled { opacity: .5; }
.err { font-size: 12.5px; color: var(--color-error); }
</style>
