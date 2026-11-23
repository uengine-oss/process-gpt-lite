<script setup>
// 스킬 열어 보기(읽기만): 일 정의가 쓰는 스킬의 글 — Lite 에 들어 있는 단계 스킬(form-fill · doc-draft …)은 하는 일을 적은 설명,
// 회사 스킬(고른 방법이 된 스킬)은 SKILL.md, 양식의 형식 규칙은 그 양식으로 만드는 문서가 늘 지키는 것(로고 · 머리글 · 고정 문구 …).
// 형식 규칙만 관리자가 고친다: 항목마다 「꼭 지킬 것」을 켜고 끄거나(글이 다시 써진다) 글을 직접 고치고, 다시 찾을 수 있다(결정 원장에 남음).
// props: name(스킬 이름) 또는 format({task, form})
import { ref, computed, onMounted } from 'vue'
import { marked } from 'marked'
import { api } from '../../api.js'
import OntoSheet from './OntoSheet.vue'
import { dateKo } from './fmt.js'

const props = defineProps({ name: { type: String, default: '' }, format: { type: Object, default: null }, admin: Boolean })
const emit = defineEmits(['close', 'changed'])
const s = ref(null) // plain skill: {name, kind, source, markdown}
const f = ref(null) // format: {format: row|null}
const err = ref('')
const busy = ref('')
const note = ref('')
const editText = ref(false)
const text = ref('')
const ticks = ref({})

const md = (t) => marked.parse(String(t || '').replace(/^---\n[\s\S]*?\n---\n?/, '').replace(/&/g, '&amp;').replace(/</g, '&lt;'), { breaks: true })
const front = (t) => (String(t || '').match(/^---\n([\s\S]*?)\n---/)?.[1] || '').split('\n').map((l) => l.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]])
const fmtPath = () => `/ontology/tasks/${encodeURIComponent(props.format.task)}/forms/format?form=${encodeURIComponent(props.format.form)}`

async function load() {
  err.value = ''
  try {
    if (props.format) { f.value = await api(fmtPath()); reset() } else s.value = await api(`/ontology/skills/${encodeURIComponent(props.name)}`)
  } catch (e) { err.value = e.message }
}
function reset() {
  const r = f.value?.format
  text.value = r?.skill_md || ''
  ticks.value = Object.fromEntries((r?.items || []).map((x) => [x.id, !!x.mandatory]))
  editText.value = false
}
onMounted(load)

const row = computed(() => f.value?.format || null)
const items = computed(() => row.value?.items || [])
const tickDirty = computed(() => items.value.some((x) => !!x.mandatory !== !!ticks.value[x.id]))
const KIND_KO = { image: '그림', header: '머리글', footer: '바닥글', phrase: '고정 문구', title: '제목', filename: '파일 이름' }

async function mine() {
  busy.value = 'mine'; err.value = ''; note.value = ''
  try {
    f.value = await api(fmtPath().split('?')[0], { method: 'POST', body: { form: props.format.form } })
    reset()
    note.value = row.value?.source?.lowConfidence ? '찾았어요. 양식 파일이 하나뿐이라 확신은 낮아요 — 꼭 지킬 것을 확인해 주세요.' : '찾았어요. 꼭 지킬 것을 확인하고 저장하세요.'
    emit('changed')
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function save(withText) {
  busy.value = 'save'; err.value = ''; note.value = ''
  try {
    const body = withText ? { form: props.format.form, skill_md: text.value } : { form: props.format.form, items: items.value.map((x) => ({ id: x.id, mandatory: !!ticks.value[x.id] })) }
    f.value = await api(fmtPath().split('?')[0], { method: 'PUT', body })
    reset()
    note.value = withText ? '글을 저장했어요.' : '저장했어요. 다음에 이 양식으로 만드는 문서부터 이대로 점검해요.'
    emit('changed')
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const title = computed(() => (props.format ? `「${String(props.format.form).replace(/\.[a-z0-9]+$/i, '')}」 형식 규칙` : props.name))
</script>

<template>
  <OntoSheet :title="title" @close="emit('close')">
    <template #title>{{ format ? '형식 규칙' : '스킬' }}</template>
    <div class="sv" data-testid="onto-skill-view" :data-skill="name || 'format'">
      <h3>{{ title }}</h3>
      <p v-if="err" class="err">{{ err }}</p>

      <!-- 단계 스킬 · 회사 스킬 -->
      <template v-if="!format && s">
        <small class="src">{{ s.source || '스킬' }}</small>
        <dl v-if="front(s.markdown).length" class="fm">
          <template v-for="[k, v] in front(s.markdown)" :key="k"><dt>{{ k }}</dt><dd>{{ v }}</dd></template>
        </dl>
        <div class="md" v-html="md(s.markdown)" />
      </template>

      <!-- 양식의 형식 규칙 -->
      <template v-else-if="format && f">
        <template v-if="row">
          <small class="src" data-testid="onto-format-source">
            {{ row.by === 'person' ? '사람이 확인함' : 'AI 가 찾음 · 아직 사람이 확인하지 않았어요' }} · 파일 {{ row.source?.n || 0 }}개에서<template v-if="row.source?.fetched"> (메일에서 다시 읽은 {{ row.source.fetched }}개 포함)</template> · {{ dateKo(row.at) }}
          </small>
          <p v-if="row.source?.lowConfidence" class="low" data-testid="onto-format-low">양식 파일이 하나뿐이라 무엇이 건마다 같은지 견주지 못했어요(낮은 확신).</p>
          <ul class="its" data-testid="onto-format-items">
            <li v-for="x in items" :key="x.id" :class="{ must: ticks[x.id] }" data-testid="onto-format-item" :data-kind="x.kind" :data-mandatory="ticks[x.id] ? '1' : '0'">
              <label class="ck">
                <input type="checkbox" :checked="!!ticks[x.id]" :disabled="!admin || !!busy" @change="ticks = { ...ticks, [x.id]: $event.target.checked }" />
                <span>{{ ticks[x.id] ? '꼭' : '좋음' }}</span>
              </label>
              <div class="it">
                <b>{{ x.name }}</b>
                <small>{{ KIND_KO[x.kind] || x.kind }}<template v-if="(f.format.whereKo?.[x.id] || x.where) !== (KIND_KO[x.kind] || x.kind)"> · {{ f.format.whereKo?.[x.id] || x.where }}</template><template v-if="x.of > 1"> · 파일 {{ x.of }}개 중 {{ x.files }}개</template></small>
                <q v-if="x.kind !== 'image'">{{ x.text }}</q>
                <small v-else class="img">{{ x.text }}</small>
                <small v-if="x.why" class="why">{{ x.why }}</small>
              </div>
            </li>
          </ul>
          <p v-if="!items.length" class="muted">늘 지키는 그림 · 글을 찾지 못했어요.</p>
          <div v-if="admin" class="btns">
            <button class="ghost press" :disabled="!!busy" data-testid="onto-format-mine" @click="mine">{{ busy === 'mine' ? '다시 찾는 중…' : '다시 찾기' }}</button>
            <button class="ghost press" :disabled="!!busy" @click="editText = !editText">{{ editText ? '글 접기' : '글로 고치기' }}</button>
            <button class="go press" :disabled="!!busy || !tickDirty" data-testid="onto-format-save" @click="save(false)">{{ busy === 'save' ? '저장하는 중…' : '저장' }}</button>
          </div>
          <template v-if="editText && admin">
            <textarea v-model="text" class="ed" spellcheck="false" data-testid="onto-format-text" />
            <div class="btns"><button class="go press" :disabled="!!busy || text === row.skill_md || !text.trim()" @click="save(true)">글 저장</button></div>
          </template>
          <details class="raw">
            <summary>스킬 글(SKILL.md)</summary>
            <div class="md" v-html="md(row.skill_md)" />
          </details>
        </template>
        <template v-else>
          <p class="muted">아직 이 양식의 형식 규칙이 없어요. 양식 파일에서 로고 · 머리글 · 바닥글 · 늘 쓰는 문구를 찾아 AI 가 이름을 붙여요.</p>
          <button v-if="admin" class="go press" :disabled="!!busy" data-testid="onto-format-mine" @click="mine">{{ busy === 'mine' ? '찾는 중… (1~2분)' : '형식 규칙 찾기' }}</button>
        </template>
      </template>
      <p v-else-if="!err" class="muted pulse">불러오는 중…</p>
      <small v-if="note" class="ok">{{ note }}</small>
    </div>
  </OntoSheet>
</template>

<style scoped>
.sv { display: flex; flex-direction: column; gap: 10px; word-break: keep-all; overflow-wrap: anywhere; }
h3 { margin: 0; font-size: 18px; font-weight: 600; }
.src { font-size: 12.5px; color: var(--text-secondary); }
.low { margin: 0; padding: 8px 10px; border-radius: 10px; font-size: 12.5px; background: color-mix(in srgb, var(--color-warning, #b26a00) 14%, transparent); }
.fm { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 0; font-size: 12.5px; padding: 8px 10px; border-radius: 10px; background: var(--field-bg); }
.fm dt { color: var(--text-secondary); } .fm dd { margin: 0; }
.md { font-size: 13.5px; line-height: 1.6; }
.md :deep(h1) { font-size: 16px; margin: .4em 0; } .md :deep(h2) { font-size: 14px; margin: .8em 0 .3em; } .md :deep(p) { margin: 0 0 .5em; }
.md :deep(ol), .md :deep(ul) { margin: 0 0 .5em; padding-left: 1.3em; } .md :deep(blockquote) { margin: .4em 0; padding: 4px 10px; border-left: 3px solid var(--hairline); color: var(--text-secondary); }
.its { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.its li { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); }
.its li.must { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-success) 60%, transparent); }
.ck { display: flex; flex-direction: column; align-items: center; gap: 2px; font-size: 11px; color: var(--text-secondary); flex: none; width: 34px; }
.it { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.it b { font-size: 14px; font-weight: 600; }
.it small { font-size: 12px; color: var(--text-secondary); }
.it q { font-size: 13px; line-height: 1.45; quotes: '「' '」'; }
.it .why { color: var(--text-tertiary); }
.muted { margin: 0; font-size: 13.5px; color: var(--text-secondary); line-height: 1.5; }
.err { margin: 0; font-size: 13px; color: var(--color-error); }
.ok { font-size: 12.5px; color: var(--color-success); }
.btns { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; }
.ghost { height: 32px; padding: 0 13px; border-radius: 9999px; font-size: 13px; background: var(--field-bg); }
.go { height: 32px; padding: 0 15px; border-radius: 9999px; font-size: 13px; font-weight: 600; background: var(--ink); color: var(--ink-inverse); align-self: flex-end; }
.go:disabled, .ghost:disabled { opacity: .45; cursor: default; }
.ed { width: 100%; min-height: 240px; resize: vertical; padding: 10px 12px; border-radius: 12px; border: 0; outline: 0; background: var(--field-bg); font: 12.5px/1.55 ui-monospace, Menlo, monospace; color: var(--text-primary); }
.raw summary { cursor: pointer; font-size: 12.5px; color: var(--text-secondary); }
</style>
