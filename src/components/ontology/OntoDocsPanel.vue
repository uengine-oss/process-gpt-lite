<script setup>
// 문서(design-v0.3 §17): 규정 · 업무 정의서를 올리면 process-gpt 의 문서 읽기(PDF2BPMN)가 절차를 뽑고, 절차마다
// 「문서대로 · 실제로」를 나란히 보여 준다 — 단계마다 메일 · 인계에서도 보이는지(몇 건), 문서에만 있는 단계,
// 가장 닮은 실제 흐름에서 문서에 없는 일. 읽는 동안에는 진행 줄(feed)을 보여 준다.
// 같은 올리기로 대화 기록(카카오톡 대화 내보내기 CSV · TXT, design-v0.3 §21)도 받는다: 메일처럼 읽고(진행 줄) 지도를 다시 그린 뒤 changed.
// emits task(key) · proc(key) · changed
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { api, freshToken } from '../../api.js'
import { BASE } from '../../base.js'

const props = defineProps({ tasks: { type: Array, default: () => [] } })
const emit = defineEmits(['task', 'proc', 'changed'])
const d = ref({ documents: [], procedures: [] })
const err = ref('')
const job = ref(null)
const open = ref('')
const file = ref(null)
let timer = null

async function load() { try { d.value = await api('/ontology/documents') } catch (e) { err.value = e.message } }
onMounted(load)
onBeforeUnmount(() => clearTimeout(timer))

async function upload(ev) {
  const f = ev.target.files?.[0]
  ev.target.value = ''
  if (!f) return
  err.value = ''
  try {
    const r = await fetch(`${BASE}/api/ontology/documents`, { method: 'POST', body: f,
      headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(f.name), Authorization: `Bearer ${await freshToken()}` } })
    const out = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(out.error || '올리지 못했어요.')
    follow(out.job, f.name, out.kind || 'document')
  } catch (e) { err.value = e.message }
}
// a document: its job; a chat export: its reading, then the map drawn again from it (the build the server starts after)
function follow(id, name, kind = 'document') {
  job.value = { id, name, kind, status: 'running', feed: [] }
  let build = null
  const tick = async () => {
    const j = await api(`/ontology/jobs/${build || id}`).catch(() => null)
    // a chat's reading done is not the end: the map is drawn after it (the status stays running until the build is done)
    if (j) job.value = { id, name, kind, stage: build ? 'build' : 'read', status: kind === 'chat' && !build && j.status === 'done' ? 'running' : j.status, feed: (j.detail?.feed || []).slice(-6), error: j.error, done: j.done, total: j.total }
    if (j?.status === 'running' || !j) { timer = setTimeout(tick, 1500); return }
    if (j.status === 'failed') { err.value = j.error || (kind === 'chat' ? '대화 기록을 읽지 못했어요.' : '문서를 읽지 못했어요.'); job.value.status = 'failed'; return }
    if (kind === 'chat' && !build) {
      // the build the chat's reading started
      const st = await api('/ontology/status').catch(() => null)
      if (st?.build?.id && new Date(st.build.started_at || 0) >= new Date(j.started_at || 0)) build = st.build.id
      job.value = { ...job.value, status: 'running', stage: 'build' }
      timer = setTimeout(tick, 1500)
      return
    }
    if (kind === 'chat') { job.value = { ...job.value, status: 'done' }; emit('changed'); return }
    await load()
    if (j.status === 'done') open.value = d.value.procedures.find((p) => p.doc === name)?.key || ''
  }
  tick()
}
const taskKey = (name) => props.tasks.find((t) => t.name === name)?.key || name
</script>

<template>
  <div class="dp" data-testid="onto-docs">
    <p class="muted">규정 · 업무 정의서를 올리면 거기 적힌 절차를 읽어, 메일 · 인계에서 찾은 실제 일과 나란히 보여 줘요. PDF · 한글 · 워드 · 파워포인트 · 엑셀 · 텍스트.</p>
    <p class="muted">단체 대화방을 내보낸 파일(카카오톡 대화 내보내기 CSV · TXT)을 올리면 메일처럼 읽어 지도에 더해요.</p>
    <label class="up press" data-testid="onto-docs-upload">
      <input ref="file" type="file" accept=".pdf,.docx,.hwpx,.pptx,.xlsx,.txt,.md,.csv" hidden @change="upload" />
      문서 · 대화 기록 올리기
    </label>
    <p v-if="err" class="err">{{ err }}</p>

    <div v-if="job && job.status === 'running'" class="sec" data-testid="onto-docs-job" :data-kind="job.kind" :data-stage="job.stage || 'read'">
      <h4 v-if="job.kind === 'chat' && job.stage === 'build'">대화 기록으로 지도 다시 그리는 중…</h4>
      <h4 v-else-if="job.kind === 'chat'">대화 기록 「{{ job.name }}」 읽는 중<small v-if="job.total">{{ job.done || 0 }}/{{ job.total }}번째 묶음</small></h4>
      <h4 v-else>「{{ job.name }}」 읽는 중<small v-if="job.total">{{ job.done || 0 }}/{{ job.total }}부분</small></h4>
      <div v-if="job.kind === 'chat' && job.total && job.stage !== 'build'" class="bar"><i :style="{ width: `${Math.min(100, (job.done || 0) / job.total * 100)}%` }" /></div>
      <ul class="feed"><li v-for="f in job.feed" :key="f.at + f.text">{{ f.text }}</li></ul>
    </div>

    <p v-if="job && job.kind === 'chat' && job.status === 'done'" class="ok" data-testid="onto-docs-chat-done">대화 기록을 지도에 더했어요.</p>
    <p v-if="!d.procedures.length && !(job && job.status === 'running')" class="muted sm">아직 올린 문서가 없어요.</p>
    <div v-for="p in d.procedures" :key="p.key" class="sec proc" :class="{ on: open === p.key }" data-testid="onto-doc-proc">
      <button class="ph press" @click="open = open === p.key ? '' : p.key">
        <b>{{ p.name }}</b>
        <small>{{ p.doc }} · 단계 {{ p.steps.length }}개 중 메일에서도 {{ p.steps.filter((s) => s.seen).length }}개</small>
      </button>
      <template v-if="open === p.key">
        <p v-if="p.description" class="muted">{{ p.description }}</p>
        <ol class="steps">
          <li v-for="s in p.steps" :key="s.key" :class="{ seen: s.seen }" data-testid="onto-doc-step" :data-seen="s.seen ? '1' : '0'">
            <div class="sn">
              <b>{{ s.name }}</b>
              <span v-if="s.role" class="tag">{{ s.role }}</span>
              <span v-if="s.seen" class="tag ok">메일에서도 {{ s.n_cases || 0 }}건</span>
              <span v-else class="tag warn">문서에만</span>
            </div>
            <small v-if="s.seen && s.task !== s.name">지도의 「<button class="link" @click="emit('task', taskKey(s.task))">{{ s.task }}</button>」과 같은 일</small>
            <small v-if="s.evidence" class="ev">“{{ s.evidence }}”</small>
            <small v-for="t in p.then.filter((x) => x.from === s.name)" :key="t.to" class="then">→ {{ t.to }}<template v-if="t.cond"> ({{ t.cond }})</template></small>
          </li>
        </ol>
        <div v-if="p.process" class="real">
          <h4>실제로는</h4>
          <p class="muted">가장 닮은 실제 흐름은 「<button class="link" @click="emit('proc', p.process)">{{ p.process_name || '그 흐름' }}</button>」이에요(문서 단계의 {{ Math.round((p.coverage || 0) * 100) }}%가 겹쳐요).</p>
          <p v-if="p.only_mail.length" class="muted">문서에 없는데 실제로 하는 일: <template v-for="(t, i) in p.only_mail" :key="t"><button class="link" @click="emit('task', taskKey(t))">{{ t }}</button><template v-if="i < p.only_mail.length - 1"> · </template></template></p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.dp { display: flex; flex-direction: column; gap: 10px; word-break: keep-all; overflow-wrap: anywhere; min-width: 0; }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.muted.sm { font-size: 12px; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.up { align-self: flex-start; height: 36px; padding: 0 16px; border-radius: 18px; display: inline-flex; align-items: center; background: var(--ink); color: var(--text-primary-on); font-size: 13.5px; font-weight: 500; cursor: pointer; }
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; display: flex; flex-direction: column; gap: 8px; }
h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
h4 small { font-weight: 400; color: var(--text-tertiary); margin-left: 6px; }
.bar { height: 8px; border-radius: 4px; background: var(--field-bg); overflow: hidden; position: relative; }
.bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--color-success); transition: width .6s; }
.feed { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.feed li { font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); padding-left: 10px; border-left: 2px solid var(--hairline); }
.feed li:last-child { color: var(--text-primary); border-left-color: var(--color-success); }
.ph { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: left; }
.ph b { font-size: 14.5px; font-weight: 600; }
.ph small { font-size: 12px; color: var(--text-secondary); }
.steps { margin: 0; padding: 0 0 0 18px; display: flex; flex-direction: column; gap: 8px; }
.steps li { font-size: 13.5px; }
.steps li::marker { color: var(--text-tertiary); }
.sn { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; }
.sn b { font-weight: 600; }
.steps small { display: block; font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.steps .ev { color: var(--text-tertiary); }
.tag { font-size: 11.5px; padding: 1px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.tag.ok { background: color-mix(in srgb, var(--color-success) 20%, transparent); color: var(--color-success); font-weight: 600; }
.tag.warn { background: rgba(232, 145, 58, .16); color: #ffb36b; }
:root[data-theme="light"] .tag.warn { color: #b35c00; }
.real { border-top: 1px solid var(--hairline); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.link { text-align: left; text-decoration: underline; text-decoration-color: var(--hairline); text-underline-offset: 3px; }
</style>
