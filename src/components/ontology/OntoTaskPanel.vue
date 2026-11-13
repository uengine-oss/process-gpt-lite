<script setup>
// 일 하나: 메일 · 채팅에서 불린 다른 이름, 메일에 오간 양식, 일 정의(SKILL.md 모양, kind: task)와 고정.
// 정의 편집 · 양식에서 초안 · 고정은 관리자만. hideHeader: 바깥 틀(SidePanel)이 이름을 보일 때 이름 줄을 빼고 태그만.
// 방법 후보(v0.3 §10, OntoWays): 같은 일을 사람마다 다르게 하는 방법 — 고른 방법이 스킬이 되면 정의를 다시 불러온다.
// emits changed({kind:'definition'|'pin'|'skill', ...})
import { ref, computed, watch } from 'vue'
import { marked } from 'marked'
import { api } from '../../api.js'
import { HOW_KO } from './fmt.js'
import OntoWhenReason from './OntoWhenReason.vue'
import OntoWays from './OntoWays.vue'
import { ACT_KO, RUNNER_KO, AUTONOMY_KO, validFromOf, dayKo, EUL } from './ontoText.js'

const props = defineProps({ taskKey: { type: String, required: true }, admin: Boolean, hideHeader: Boolean })
const emit = defineEmits(['changed'])
const d = ref(null)
const err = ref('')
const loading = ref(true)
const mode = ref('view')
const text = ref('')
const note = ref('')
const busy = ref('')
const fields = ref('')
const allLabels = ref(false)
const pick = ref('')

async function load() {
  loading.value = true; err.value = ''; note.value = ''; fields.value = ''
  try {
    d.value = await api(`/ontology/tasks/${encodeURIComponent(props.taskKey)}`)
    text.value = d.value.definition || ''
    pick.value = withFile.value[0]?.pick || ''
    mode.value = 'view'
  } catch (e) { err.value = e.message; d.value = null } finally { loading.value = false }
}
watch(() => props.taskKey, load, { immediate: true })

const t = computed(() => d.value?.task || {})
const p = computed(() => d.value?.parsed || {})
// 일 이름과 똑같은 말은 「다른 이름」이 아니다. 개인 습관의 원래 말(act habit)은 회사 화면에 보이지 않는다(design-v0.3 §3.4)
const labels = computed(() => (d.value?.labels || []).filter((l) => l.raw && l.act !== 'habit' && l.raw.trim() !== String(d.value?.task?.key || '').trim()))
const shownLabels = computed(() => (allLabels.value ? labels.value : labels.value.slice(0, 3)))
// 메일 첨부 이름은 고객마다 달라(견적서_달빛커피.xlsx · 견적서_한빛치과.xlsx …) 같은 양식 파일이면 한 줄로 모은다.
// pick: 초안 만들기에 넘길 이름(서버 templates 의 name 중 하나)
const templates = computed(() => {
  const g = new Map()
  for (const x of d.value?.templates || []) {
    const k = x.file || x.name
    const cur = g.get(k)
    if (cur) { cur.seen += x.seen || 0; cur.variants += 1 } else g.set(k, { ...x, name: x.file ? x.file.split('/').pop() : x.name, pick: x.name, seen: x.seen || 0, variants: 1 })
  }
  return [...g.values()].sort((a, b) => b.seen - a.seen)
})
const allTpl = ref(false)
const shownTemplates = computed(() => (allTpl.value ? templates.value : templates.value.slice(0, 3)))
const withFile = computed(() => templates.value.filter((x) => x.file))
const hasDef = computed(() => !!(d.value?.definition || '').trim())
const dirty = computed(() => text.value !== (d.value?.definition || ''))
const kindOfFile = (type) => ({ xlsx: 'xls', docx: 'doc', hwpx: 'hwp', pptx: 'ppt' }[type] || 'etc')
const md = (s) => marked.parse(String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;'), { breaks: true })
const outName = (o) => (typeof o === 'string' ? o : [o.name, o.format].filter(Boolean).join(' · '))

async function draft() {
  busy.value = 'draft'; err.value = ''; note.value = ''
  try {
    const r = await api(`/ontology/tasks/${encodeURIComponent(props.taskKey)}/draft`, { method: 'POST', body: pick.value ? { template: pick.value } : {} })
    text.value = r.definition || ''
    fields.value = r.fields || ''
    mode.value = 'edit'
    note.value = r.template ? `「${r.template.file ? r.template.file.split('/').pop() : r.template.name}」에서 초안을 만들었어요. 저장해야 반영돼요.` : '양식 없이 일 이름과 앞뒤 일로 초안을 만들었어요. 저장해야 반영돼요.'
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function save() {
  busy.value = 'save'; err.value = ''
  try {
    d.value = await api(`/ontology/tasks/${encodeURIComponent(props.taskKey)}/definition`, { method: 'PUT', body: { definition: text.value } })
    text.value = d.value.definition || ''
    fields.value = ''
    mode.value = 'view'
    note.value = '저장했어요. 다음 스냅샷부터 이 정의로 실행해요.'
    emit('changed', { kind: 'definition', key: props.taskKey })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}

// 고정: 스위치를 바꾸면 이유 · 효력일을 묻고 적용한다
const pinOpen = ref(false)
const pinReason = ref('')
const pinDate = ref('')
const pinNote = ref('')
function togglePin() { pinOpen.value = !pinOpen.value; pinReason.value = ''; pinDate.value = ''; pinNote.value = '' }
async function applyPin() {
  busy.value = 'pin'; err.value = ''
  const pinned = !t.value.pinned
  const validFrom = validFromOf(pinDate.value)
  try {
    await api(`/ontology/tasks/${encodeURIComponent(props.taskKey)}/pin`, { method: 'POST', body: { pinned, ...(validFrom ? { validFrom } : {}), reason: pinReason.value.trim() } })
    pinOpen.value = false
    if (validFrom) pinNote.value = `${dayKo(pinDate.value)}부터 ${pinned ? '고정돼요' : '고정이 풀려요'}.`
    else { d.value = { ...d.value, task: { ...d.value.task, pinned } }; pinNote.value = pinned ? '고정했어요. 스냅샷이 이 일을 돌아가지 않아요.' : '고정을 풀었어요.' }
    emit('changed', { kind: 'pin', key: props.taskKey, pinned, validFrom: validFrom || null })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
// a way became this task's skill: its definition now lists it
async function skilled(x) { await load(); note.value = ''; emit('changed', { kind: 'skill', key: props.taskKey, name: x.name }) }
defineExpose({ reload: load })
</script>

<template>
  <section class="tp" data-testid="onto-task-panel">
    <p v-if="loading && !d" class="muted pulse">불러오는 중…</p>
    <p v-else-if="!d && err" class="err">{{ err }}</p>
    <template v-else-if="d">
      <header class="hd">
        <template v-if="!hideHeader"><span class="badge">일</span>
        <h3>{{ t.name || t.key }}</h3></template>
        <div class="meta">
          <span v-if="t.role" class="tag">{{ t.role }}</span>
          <span v-if="p.runner" class="tag" :class="p.runner">{{ RUNNER_KO[p.runner] }}</span>
          <span v-if="t.pinned" class="tag pin" data-testid="onto-task-pinned">고정</span>
          <span v-if="t.status === 'retired'" class="tag ret">은퇴함</span>
          <small v-if="t.n">{{ t.n }}번 나왔어요</small>
        </div>
      </header>

      <!-- 고정 -->
      <div v-if="admin" class="pinrow sec">
        <div class="pr">
          <div class="pt"><b>고정</b><small>{{ t.pinned ? '스냅샷이 이 일을 늘 지나가요.' : '고정하면 확률이 낮아도 늘 이 일을 지나가요.' }}</small></div>
          <button class="sw press" role="switch" :aria-checked="!!t.pinned" :class="{ on: t.pinned, pending: pinOpen }" data-testid="onto-pin-toggle" @click="togglePin"><span /></button>
        </div>
        <div v-if="pinOpen" class="pinform">
          <OntoWhenReason v-model:reason="pinReason" v-model:date="pinDate" :placeholder="t.pinned ? '고정을 푸는 이유(선택)' : '고정하는 이유(선택)'" />
          <div class="btns">
            <button class="ghost press" :disabled="!!busy" @click="pinOpen = false">취소</button>
            <button class="go press" :disabled="!!busy" data-testid="onto-pin-apply" @click="applyPin">{{ busy === 'pin' ? '적용하는 중…' : t.pinned ? '고정 풀기' : '고정하기' }}</button>
          </div>
        </div>
        <small v-if="pinNote" class="ok" data-testid="onto-pin-note">{{ pinNote }}</small>
      </div>

      <!-- 다른 이름 -->
      <div v-if="labels.length" class="sec">
        <h4>다른 이름 <small>메일 · 채팅에서 이렇게 불렸어요</small></h4>
        <ul class="labels">
          <li v-for="l in shownLabels" :key="l.raw">
            <q>{{ l.raw }}</q>
            <small>{{ ACT_KO[l.act] || l.act }}<template v-if="HOW_KO[l.how]"> · {{ HOW_KO[l.how] }}</template></small>
          </li>
        </ul>
        <button v-if="labels.length > 3" class="more press" @click="allLabels = !allLabels">{{ allLabels ? '접기' : `모두 보기 (${labels.length})` }}</button>
      </div>

      <!-- 메일에서 본 양식 -->
      <div v-if="templates.length" class="sec">
        <h4>메일에서 본 양식</h4>
        <ul class="tpl">
          <li v-for="x in shownTemplates" :key="x.file || x.name" data-testid="onto-template">
            <span class="fic" :class="kindOfFile(x.type)">{{ (x.type || '').toUpperCase().slice(0, 4) }}</span>
            <span class="tn"><b :title="x.example">{{ x.name }}</b><small>메일 {{ x.seen }}번<template v-if="x.variants > 1"> · 파일 이름 {{ x.variants }}가지</template><template v-if="x.file"> · 양식 파일 있음</template></small>
              <!-- the form's own labels: what the company's attachments of that form always have (server mailbody.js formFields) -->
              <small v-if="x.fields?.length" class="tf" data-testid="onto-template-fields">칸 · {{ x.fields.slice(0, 10).join(' · ') }}<template v-if="x.fields.length > 10"> 외 {{ x.fields.length - 10 }}개</template></small></span>
          </li>
        </ul>
        <button v-if="templates.length > 3" class="more press" @click="allTpl = !allTpl">{{ allTpl ? '접기' : `모두 보기 (${templates.length})` }}</button>
      </div>

      <!-- 일 정의 -->
      <div class="sec def">
        <div class="dh">
          <h4>일 정의</h4>
          <span v-if="admin" class="seg">
            <button :class="{ on: mode === 'view' }" @click="mode = 'view'">보기</button>
            <button :class="{ on: mode === 'edit' }" data-testid="onto-def-edit" @click="mode = 'edit'">편집</button>
          </span>
        </div>

        <template v-if="mode === 'view'">
          <template v-if="hasDef">
            <p v-if="p.description" class="desc">{{ p.description }}</p>
            <dl class="kv">
              <dt>하는 사람</dt><dd>{{ RUNNER_KO[p.runner] || '사람' }}<template v-if="p.runner === 'agent'"> · {{ AUTONOMY_KO[p.autonomy] || p.autonomy }}</template></dd>
              <template v-if="p.skills?.length"><dt>스킬</dt><dd class="chips"><code v-for="s in p.skills" :key="s">{{ s }}</code></dd></template>
              <template v-if="p.outputs?.length"><dt>내놓는 것</dt><dd><span v-for="(o, i) in p.outputs" :key="i" class="out">{{ outName(o) }}<small v-if="o.template"> · 양식 {{ o.template }}</small></span></dd></template>
            </dl>
            <div v-if="p.checkpoints?.length" class="cps">
              <span class="cl">지켜야 할 것</span>
              <ul><li v-for="c in p.checkpoints" :key="c">{{ c }}</li></ul>
            </div>
            <div v-if="p.instruction" class="body md" v-html="md(p.instruction)" />
          </template>
          <p v-else class="muted">아직 정의가 없어요. 지금은 사람이 하는 일로 실행해요.<template v-if="admin && withFile.length"> 메일에 오간 양식으로 초안을 만들 수 있어요.</template></p>
          <button v-if="admin && !hasDef" class="go wide press" :disabled="!!busy" data-testid="onto-def-draft" @click="draft">{{ busy === 'draft' ? '초안 만드는 중…' : '양식에서 초안 만들기' }}</button>
        </template>

        <template v-else>
          <div class="edtools">
            <select v-if="withFile.length > 1" v-model="pick" class="sel" aria-label="양식">
              <option v-for="x in withFile" :key="x.pick" :value="x.pick">{{ x.name }}</option>
            </select>
            <button class="ghost2 press" :disabled="!!busy" data-testid="onto-def-draft" @click="draft">{{ busy === 'draft' ? '초안 만드는 중…' : '양식에서 초안 만들기' }}</button>
          </div>
          <textarea v-model="text" class="ed" spellcheck="false" :placeholder="'---\nname: ' + taskKey + '\nkind: task\nrunner: person\n---\n\n## 하는 일\n1. '" data-testid="onto-def-text" />
          <details v-if="fields" class="fields"><summary>양식에서 읽은 칸</summary><pre>{{ fields }}</pre></details>
          <div class="btns">
            <button class="ghost press" :disabled="!!busy" @click="text = d.definition || ''; mode = 'view'; note = ''">취소</button>
            <button class="go press" :disabled="!!busy || !dirty || !text.trim()" data-testid="onto-def-save" @click="save">{{ busy === 'save' ? '저장하는 중…' : '저장' }}</button>
          </div>
        </template>
        <small v-if="note" class="ok" data-testid="onto-def-note">{{ note }}</small>
      </div>

      <!-- 방법 후보 -->
      <OntoWays :task-key="taskKey" :admin="admin" @skill="skilled" />
      <p v-if="err" class="err">{{ err }}</p>
      <small v-if="!admin && !hasDef" class="muted">일 정의는 관리자가 써요. 「{{ t.name || taskKey }}」{{ EUL(t.name || taskKey) }} 어떻게 할지 정해 두면 에이전트가 맡을 수 있어요.</small>
    </template>
  </section>
</template>

<style scoped>
.tp { word-break: keep-all; overflow-wrap: anywhere; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.hd { display: flex; flex-direction: column; gap: 4px; }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
h3 { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
h4 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
h4 small { font-weight: 400; color: var(--text-tertiary); margin-left: 4px; }
.meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); }
.tag { font-size: 12px; padding: 2px 9px; border-radius: 9999px; background: var(--field-bg); color: var(--text-primary); }
.tag.agent { background: color-mix(in srgb, #7c3aed 26%, transparent); }
.tag.pin { background: color-mix(in srgb, var(--color-info) 22%, transparent); color: var(--color-info); font-weight: 600; }
.tag.ret { color: var(--text-secondary); }
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.ok { display: block; margin-top: 8px; font-size: 12.5px; color: var(--color-success); }

.pr { display: flex; align-items: center; gap: 12px; }
.pt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.pt b { font-size: 14px; font-weight: 600; }
.pt small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; }
.sw { position: relative; flex: none; width: 46px; height: 28px; border-radius: 9999px; background: var(--field-bg); box-shadow: inset 0 0 0 1px var(--hairline); transition: background .2s; }
.sw span { position: absolute; top: 3px; left: 3px; width: 22px; height: 22px; border-radius: 50%; background: var(--text-primary); transition: translate .25s var(--spring); }
.sw.on { background: var(--color-info); } .sw.on span { translate: 18px 0; background: #fff; }
.sw.pending { box-shadow: inset 0 0 0 2px var(--color-info); }
.pinform { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }

.labels { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.labels li { display: flex; flex-direction: column; gap: 2px; }
.labels q { font-size: 13.5px; line-height: 1.45; quotes: '“' '”'; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.labels small { font-size: 11.5px; color: var(--text-tertiary); }
.more { margin-top: 6px; font-size: 12.5px; color: var(--color-info); }

.tpl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tpl li { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tpl .tf { display: block; margin-top: 2px; color: var(--text-secondary); line-height: 1.45; white-space: normal; }
.fic { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.xls { background: #217346; } .fic.doc { background: #2b579a; } .fic.hwp { background: #1f6fd1; } .fic.ppt { background: #c43e1c; }
.tn { display: flex; flex-direction: column; min-width: 0; }
.tn b { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tn small { font-size: 12px; color: var(--text-secondary); }

.dh { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.dh h4 { margin: 0; }
.seg { display: inline-flex; padding: 2px; border-radius: 9999px; background: var(--field-bg); flex: none; }
.seg button { height: 26px; padding: 0 12px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.desc { margin: 0 0 10px; font-size: 14px; line-height: 1.5; }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0 0 10px; font-size: 13.5px; }
.kv dt { color: var(--text-secondary); white-space: nowrap; }
.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chips code { font: 12px ui-monospace, Menlo, monospace; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); }
.out { display: block; }
.out small { color: var(--text-tertiary); }
.cps { margin-bottom: 10px; }
.cl { display: block; font-size: 12.5px; color: var(--text-secondary); margin-bottom: 4px; }
.cps ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cps li { position: relative; padding-left: 20px; font-size: 13.5px; line-height: 1.45; }
.cps li::before { content: ''; position: absolute; left: 3px; top: 4px; width: 9px; height: 5px; border-left: 2px solid var(--color-success); border-bottom: 2px solid var(--color-success); rotate: -45deg; }
.body { font-size: 13.5px; line-height: 1.55; border-top: 1px solid var(--hairline); padding-top: 8px; overflow-wrap: anywhere; }
.md :deep(h2), .md :deep(h3) { font-size: 13.5px; font-weight: 600; margin: .3em 0; }
.md :deep(p) { margin: 0 0 .4em; } .md :deep(ol), .md :deep(ul) { margin: 0; padding-left: 1.3em; }

.edtools { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.sel { flex: 1 1 140px; min-width: 0; height: 32px; padding: 0 8px; border-radius: 10px; border: 0; background: var(--field-bg); font-size: 13px; }
.ed { width: 100%; min-height: 260px; resize: vertical; padding: 10px 12px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font: 12.5px/1.55 ui-monospace, Menlo, monospace; color: var(--text-primary); tab-size: 2; }
.ed:focus { box-shadow: inset 0 0 0 1.5px var(--hairline); }
.fields { margin-top: 6px; font-size: 12.5px; color: var(--text-secondary); }
.fields summary { cursor: pointer; }
.fields pre { max-height: 160px; overflow: auto; margin: 6px 0 0; padding: 8px 10px; border-radius: 10px; background: var(--field-bg); font-size: 11.5px; white-space: pre-wrap; }
.btns { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
.ghost { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 13.5px; color: var(--text-secondary); }
.ghost2 { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 13px; font-weight: 500; background: var(--field-bg); }
.go { height: 34px; padding: 0 16px; border-radius: 9999px; font-size: 13.5px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); }
.go.wide { margin-top: 10px; }
.go:disabled, .ghost:disabled, .ghost2:disabled { opacity: .45; cursor: default; }
</style>
