<script setup>
// 일 패널의 「메일에서 본 양식」(server lib/ontology/formats.js formsView): 이 일이 쓰는 양식이 무엇이고 왜인지(정해 둔 양식 · 가장 많이 쓴
// 양식(자동)), 양식마다 어디서 왔는지(메일 N번 · 마지막 날 — 메일 제목 · 파일 이름 · 링크는 그 메일함 주인만), 남겨 둔 파일이 있으면 이음오피스로
// 열어 보기(메일함 주인 · 관리자), 형식 규칙(로고 · 머리글 · 고정 문구 — 열어 보기, 관리자는 찾기 · 고치기). 관리자는 다른 양식을 고르거나
// (다른 일의 양식도) 고르기를 풀 수 있다. 바꾸면 emit changed.
import { ref, computed, watch } from 'vue'
import { api } from '../../api.js'
import { dateKo } from './fmt.js'
import OntoDocSheet from './OntoDocSheet.vue'
import OntoSkillView from './OntoSkillView.vue'

const props = defineProps({ taskKey: { type: String, required: true }, admin: Boolean })
const emit = defineEmits(['changed', 'loaded'])
const v = ref(null)
const err = ref('')
const busy = ref('')
const note = ref('')
const all = ref(false)
const mailsOf = ref('')     // form name whose mails are open
const doc = ref(null)       // {form} open in 이음오피스
const fmt = ref(null)       // {form} format rules open
const others = ref(null)    // company forms (admin)

const base = () => `/ontology/tasks/${encodeURIComponent(props.taskKey)}`
async function load() {
  err.value = ''
  try { v.value = await api(`${base()}/forms`) } catch (e) { err.value = e.message; v.value = null }
}
watch(() => props.taskKey, () => { v.value = null; others.value = null; note.value = ''; load() }, { immediate: true })
watch(v, (x) => emit('loaded', x))

const forms = computed(() => v.value?.forms || [])
const shown = computed(() => (all.value ? forms.value : forms.value.slice(0, 3)))
const kindOf = (t) => ({ xlsx: 'xls', docx: 'doc', hwpx: 'hwp', pptx: 'ppt' }[t] || 'etc')
const BY_KO = { person: '관리자가 골랐어요', definition: '일 정의의 「내놓는 것」에 적혀 있어요', auto: '메일에 가장 많이 오간, 파일이 있는 양식이에요' }

async function choose(form, ofTask = null) {
  busy.value = `c:${form || ''}`; err.value = ''; note.value = ''
  try {
    v.value = await api(`${base()}/form`, { method: 'PUT', body: { form, ofTask } })
    note.value = form ? `「${form}」${ofTask ? `(「${ofTask}」의 양식)` : ''}을 이 일이 쓰는 양식으로 정했어요. 다음에 문서를 만들 때부터 이 양식에서 시작해요.` : '고르기를 풀었어요. 가장 많이 쓴 양식을 써요.'
    others.value = null
    emit('changed', { kind: 'form', key: props.taskKey, form })
  } catch (e) { err.value = e.message } finally { busy.value = '' }
}
async function loadOthers() {
  busy.value = 'others'; err.value = ''
  try { others.value = (await api(`/ontology/forms/company?except=${encodeURIComponent(props.taskKey)}`)).forms } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const openLoad = (f) => () => api(`${base()}/forms/open`, { method: 'POST', body: { form: f.name } })
</script>

<template>
  <div class="sec of" data-testid="onto-forms">
    <h4>메일에서 본 양식</h4>
    <p v-if="!v && !err" class="muted pulse">불러오는 중…</p>
    <template v-if="v">
      <!-- 이 일이 쓰는 양식 -->
      <div v-if="v.chosen" class="use" data-testid="onto-form-chosen" :data-by="v.chosen.chosenBy">
        <span class="cap">이 일이 쓰는 양식</span>
        <b>{{ v.chosen.name }}</b>
        <small><span class="lbl" :class="v.chosen.chosenBy">{{ v.chosen.label }}</span> {{ BY_KO[v.chosen.chosenBy] }}<template v-if="v.chosen.ofTask"> · 「{{ v.chosen.ofTask }}」의 양식</template><template v-if="v.chosen.chosenBy === 'person' && v.chosen.at"> · {{ v.chosen.by || '관리자' }} · {{ dateKo(v.chosen.at) }}</template></small>
        <small v-if="v.wanted" class="warn">정해 둔 「{{ v.wanted.name }}」은 {{ v.wanted.why === 'no-file' ? '남겨 둔 파일이 없어' : '찾지 못해' }} 실행 때는 이 양식을 써요.</small>
        <small class="hint">문서를 만드는 단계는 이 양식 파일을 복사해 건의 요청에 맞게 고쳐 써요 — 양식은 출발점이에요.</small>
        <button v-if="admin && v.chosen.chosenBy === 'person'" class="lnk press" :disabled="!!busy" data-testid="onto-form-unchoose" @click="choose(null)">고르기 풀기</button>
      </div>
      <p v-else-if="!forms.length" class="muted" data-testid="onto-forms-none">이 일에는 메일에 첨부로 오간 양식이 없어요. 대화방에서만 찾은 일이면 첨부가 남지 않아요 — 문서를 만드는 단계는 글로 쓴 초안을 워드 파일로 만들어요.</p>
      <p v-else class="muted">이 일의 양식에는 메일에서 남겨 둔 파일이 없어요. 문서를 만드는 단계는 글로 쓴 초안을 워드 파일로 만들어요.</p>

      <ul class="tpl">
        <li v-for="x in shown" :key="`${x.ofTask || ''}:${x.name}`" :class="{ on: x.chosen }" data-testid="onto-template" :data-form="x.name" :data-chosen="x.chosen ? '1' : '0'">
          <div class="r1">
            <span class="fic" :class="kindOf(x.type)">{{ (x.type || '').toUpperCase().slice(0, 4) }}</span>
            <span class="tn">
              <b>{{ x.name }}<span v-if="x.chosen" class="mark">이 일이 쓰는 양식</span></b>
              <small>메일 {{ x.seen }}번<template v-if="x.lastAt"> · 마지막 {{ dateKo(x.lastAt) }}</template><template v-if="x.fileNames > 1"> · 파일 이름 {{ x.fileNames }}가지</template> · {{ x.hasFile ? `남겨 둔 파일 ${x.files}개` : '남겨 둔 파일 없음' }}<template v-if="x.ofTask"> · 「{{ x.ofTask }}」의 양식</template></small>
              <small v-if="x.fields?.length" class="tf" data-testid="onto-template-fields">칸 · {{ x.fields.slice(0, 10).join(' · ') }}<template v-if="x.fields.length > 10"> 외 {{ x.fields.length - 10 }}개</template></small>
            </span>
          </div>
          <div class="acts">
            <button v-if="x.canOpen" class="b press" data-testid="onto-form-open" @click="doc = x">열어 보기</button>
            <button class="b press" data-testid="onto-form-format" @click="fmt = x">
              형식 규칙<template v-if="x.format"> · 꼭 {{ x.format.mandatory }}개<template v-if="x.format.lowConfidence"> (파일 하나)</template></template><template v-else-if="admin && x.hasFile"> 찾기</template><template v-else> 없음</template>
            </button>
            <button v-if="admin && x.hasFile && !x.chosen" class="b press" :disabled="!!busy" data-testid="onto-form-choose" @click="choose(x.name, x.ofTask)">이 양식 쓰기</button>
            <button v-if="x.mails?.length" class="lnk press" :aria-expanded="mailsOf === x.name" @click="mailsOf = mailsOf === x.name ? '' : x.name">어디서 왔나요</button>
          </div>
          <ul v-if="mailsOf === x.name" class="mails" data-testid="onto-form-mails">
            <li v-for="(m, i) in x.mails" :key="i">
              <span class="d">{{ dateKo(m.at) }}</span>
              <template v-if="m.mine">
                <span class="fn">{{ m.fileName }}</span>
                <a v-if="m.link" :href="m.link" target="_blank" rel="noopener" class="sj">{{ m.subject || '메일 열기' }}</a>
                <span v-else-if="m.subject" class="sj">{{ m.subject }}</span>
                <span v-if="m.kept" class="kp">이 파일을 남겨 둠</span>
              </template>
              <span v-else class="sj dim">{{ m.chat ? '대화방' : '메일' }} · 다른 사람의 메일함(제목 · 파일 이름은 주인만 봐요)</span>
            </li>
          </ul>
        </li>
      </ul>
      <button v-if="forms.length > 3" class="more press" @click="all = !all">{{ all ? '접기' : `모두 보기 (${forms.length})` }}</button>

      <!-- 관리자: 다른 일의 양식에서 고르기 -->
      <template v-if="admin">
        <button v-if="!others" class="lnk press" :disabled="!!busy" data-testid="onto-form-others" @click="loadOthers">{{ busy === 'others' ? '회사 양식을 모으는 중…' : '다른 일의 양식에서 고르기' }}</button>
        <div v-else class="others" data-testid="onto-form-others-list">
          <small class="cap">회사의 다른 양식(메일에서 남겨 둔 파일이 있는 것)</small>
          <p v-if="!others.length" class="muted">고를 수 있는 양식이 없어요.</p>
          <button v-for="o in others" :key="`${o.task}:${o.name}`" class="chip press" :disabled="!!busy" @click="choose(o.name, o.task)">
            {{ o.name }} <small>· {{ o.task }} · 메일 {{ o.seen }}번</small>
          </button>
          <button class="lnk press" @click="others = null">닫기</button>
        </div>
      </template>
    </template>
    <small v-if="note" class="ok" data-testid="onto-forms-note">{{ note }}</small>
    <small v-if="err" class="err">{{ err }}</small>

    <OntoDocSheet v-if="doc" :name="doc.name" :load="openLoad(doc)" :note="`메일에서 남겨 둔 「${doc.name}」의 가장 최근 파일이에요(읽기만). 지난 건의 값이 들어 있어요.`" @close="doc = null" />
    <OntoSkillView v-if="fmt" :format="{ task: taskKey, form: fmt.name }" :admin="admin" @changed="load" @close="fmt = null" />
  </div>
</template>

<style scoped>
.sec { padding: 12px; border-radius: 16px; background: var(--cell-bg); min-width: 0; display: flex; flex-direction: column; gap: 8px; }
h4 { margin: 0; font-size: 13px; font-weight: 600; color: var(--text-secondary); }
.muted { margin: 0; font-size: 13px; color: var(--text-secondary); line-height: 1.5; }
.use { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border-radius: 12px; background: var(--field-bg); box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--color-info) 45%, transparent); }
.use .cap, .cap { font-size: 11.5px; color: var(--text-tertiary); letter-spacing: .03em; }
.use b { font-size: 14.5px; font-weight: 600; }
.use small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.45; }
.use .hint { color: var(--text-tertiary); }
.use .warn { color: var(--color-warning, #b26a00); }
.lbl { padding: 1px 8px; border-radius: 9999px; font-size: 11.5px; font-weight: 600; background: color-mix(in srgb, var(--color-info) 18%, transparent); color: var(--text-primary); margin-right: 2px; }
.lbl.auto { background: var(--cell-bg); color: var(--text-secondary); }
.tpl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.tpl > li { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 8px; border-radius: 12px; }
.tpl > li.on { background: color-mix(in srgb, var(--color-info) 8%, transparent); }
.r1 { display: flex; align-items: center; gap: 10px; min-width: 0; }
.fic { flex: none; width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; font-size: 10px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.xls { background: #217346; } .fic.doc { background: #2b579a; } .fic.hwp { background: #1f6fd1; } .fic.ppt { background: #c43e1c; }
.tn { display: flex; flex-direction: column; min-width: 0; }
.tn b { font-size: 14px; font-weight: 500; display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.mark { font-size: 11px; font-weight: 600; padding: 1px 7px; border-radius: 9999px; background: var(--ink); color: var(--ink-inverse); }
.tn small { font-size: 12px; color: var(--text-secondary); }
.tn .tf { display: block; margin-top: 2px; line-height: 1.45; }
.acts { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; padding-left: 44px; }
.b { height: 28px; padding: 0 11px; border-radius: 9999px; font-size: 12.5px; background: var(--field-bg); }
.b:disabled { opacity: .45; }
.lnk { font-size: 12.5px; color: var(--color-info); align-self: flex-start; }
.lnk:disabled { opacity: .5; }
.mails { list-style: none; margin: 0 0 0 44px; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.mails li { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.mails .d { color: var(--text-tertiary); flex: none; }
.mails .fn { font-weight: 500; }
.mails .sj { color: var(--text-secondary); }
.mails a.sj { color: var(--color-info); text-decoration: none; }
.mails .dim { color: var(--text-tertiary); }
.mails .kp { font-size: 11px; padding: 0 6px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.more { font-size: 12.5px; color: var(--color-info); align-self: flex-start; }
.others { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.others .cap { width: 100%; }
.chip { height: 30px; padding: 0 12px; border-radius: 9999px; background: var(--field-bg); font-size: 12.5px; box-shadow: inset 0 0 0 1px var(--hairline); }
.chip small { color: var(--text-secondary); }
.ok { font-size: 12.5px; color: var(--color-success); }
.err { font-size: 12.5px; color: var(--color-error); }
</style>
