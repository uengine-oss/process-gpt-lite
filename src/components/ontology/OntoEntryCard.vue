<script setup>
// 들어온 메일이 어느 일부터 시작하는지(server lib/ontology/run.js routeMail):
// started — 고른 일과 확률, 평소 흐름에서 건너뛴 일 · 이번 스냅샷의 일, 「건 보기」 · 「다른 일에서 시작」
// ask — 모델이 확실하지 않을 때(가장 높은 확률이 50% 아래) 두세 후보 중에서 사람이 고른다
// 서버는 이 카드 내용을 바꾸지 않으므로, 고른 결과 · 옮긴 결과는 이 기기에 남겨 다시 열어도 그대로 보인다.
import { ref, computed } from 'vue'
import { api } from '../../api.js'
import { pct } from './fmt.js'
import OntoSheet from './OntoSheet.vue'
import OntoCasePanel from './OntoCasePanel.vue'
import { local, RO } from './ontoText.js'

const props = defineProps({ msg: Object })
const saved = ref(local.get(`entry:${props.msg.id}`))
const v = computed(() => ({ ...(props.msg.content || {}), ...(saved.value || {}) }))
const choice = computed(() => v.value.choice || {})
const task = computed(() => choice.value.task || v.value.nodes?.[0] || '')
const who = computed(() => {
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

// ask → 고르면 건을 시작한다
async function start(o) {
  busy.value = o.task; err.value = ''
  const m = v.value.mail || {}
  try {
    const r = await api('/ontology/cases', { method: 'POST', body: {
      proc: choice.value.proc, entry: o.task, subject: m.subject || '', body: m.text || '', from: m.from || '', customer: v.value.customer || '',
      odds: { ...choice.value, task: o.task, p: o.p, picked: true }, kind: 'mail', messageId: props.msg.id,
    } })
    persist({ state: 'started', picked: true, choice: { ...choice.value, task: o.task, p: o.p }, caseId: r.caseId, instId: r.instId,
      skipped: r.snapshot?.skipped || [], nodes: r.snapshot?.nodes || [o.task], procDefId: r.snapshot?.procDefId })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}

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
</script>

<template>
  <div class="oe" data-testid="onto-entry-card" :data-state="v.state">
    <div class="mail">
      <span class="badge">메일</span>
      <span class="ms" :title="`${v.mail?.from || ''} · ${v.mail?.subject || ''}`">{{ v.mail?.subject || '(제목 없음)' }}</span>
    </div>

    <!-- 확실하지 않을 때: 사람이 고른다 -->
    <template v-if="v.state === 'ask'">
      <p class="q">{{ who }} 어디서 시작할지 확실하지 않아요. 어느 일부터 할까요?</p>
      <p v-if="v.mail?.text" class="ex">{{ v.mail.text }}</p>
      <div class="opts">
        <button v-for="o in options" :key="o.task" class="opt press" :disabled="!!busy" data-testid="onto-entry-option" @click="start(o)">
          <i :style="{ width: `${Math.max(3, Math.round((o.p || 0) * 100))}%` }" />
          <span class="on">{{ busy === o.task ? '시작하는 중…' : o.task }}</span><b>{{ pText(o.p) }}</b>
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
