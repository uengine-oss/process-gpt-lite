<script setup>
// 「프로젝트로 시작할까요?」 — 대화를 진짜 Lite 프로젝트로 (2026-11-27 22:33 휴대폰 녹화: 「여기로 프로젝트로 승격하겠다는 거거든」 · 「이 프로젝트에 폴더 적절한
// 이 템플릿 폴더가 좀 우리가 추천이 좀 필요할 수도 있고」 — spec chat-to-project, server lib/chatProject.js). The card the chat shows when the person
// said so in words (the router's start_project) or pressed 「프로젝트로 시작」 on an answer: the name (theirs to change), what the project is for and
// where it came from, the answer that becomes its first document, the template folders that fit — each with why — and 「빈 프로젝트로」.
// 「만들기」 makes it (a template: through the template's own 「템플릿으로 시작」 — the project's own workspace); 「아니요」 makes nothing.
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { ro } from '../josa.js'

const props = defineProps({ msg: Object })
const app = useApp()
const router = useRouter()
const c = computed(() => props.msg.content || {})
// What the card shows is what goes into the project, and only that (PR #118 review M3): the name, the purpose, what it will make, the
// background — each the person's to change before 「만들기」; what they leave as it is goes as the card showed it.
const draft = ref({ title: '', intent: '', background: '', deliverables: [] })
let touched = false
const fill = () => {
  const x = c.value
  draft.value = { title: x.title || '', intent: x.intent || '', background: x.background || '', deliverables: (Array.isArray(x.deliverables) ? x.deliverables : []).map((t) => ({ text: String(t) })) }
}
fill()
watch(() => [c.value.title, c.value.intent, c.value.background, JSON.stringify(c.value.deliverables || [])], () => { if (c.value.state === 'offered' && !touched) fill() })
const touch = () => { touched = true }
const addItem = () => { touch(); if (draft.value.deliverables.length < 5) draft.value.deliverables.push({ text: '' }) }
const dropItem = (i) => { touch(); draft.value.deliverables.splice(i, 1) }
const picked = ref(null)       // a template's slug, or null: an empty project
const busy = ref(false)
const err = ref('')
const recs = computed(() => (Array.isArray(c.value.templates) ? c.value.templates : []))
// a 「만들기」 that stopped half way (the server went away): the card can be made again, or closed (server lib/chatProject.js MAKING_STALE_MS)
const STALE_MS = 120_000
// (read again every few seconds while the card says 「만드는 중」 — a claim goes stale with no change to the card)
const now = ref(Date.now())
let tick = null
watch(() => c.value.state === 'making', (making) => {
  clearInterval(tick)
  tick = making ? setInterval(() => { now.value = Date.now() }, 5000) : null
}, { immediate: true })
onBeforeUnmount(() => clearInterval(tick))
const stale = computed(() => c.value.state === 'making' && !c.value.project?.id && now.value - new Date(c.value.making_at || 0).getTime() > STALE_MS)
const state = computed(() => (busy.value ? 'making' : stale.value ? 'offered' : c.value.state || 'offered'))
const mailLine = computed(() => (c.value.source?.mail ? `받은 메일 「${c.value.source.mail.subject}」${c.value.source.mail.from ? ` · ${c.value.source.mail.from}` : ''}` : ''))
// (one sentence with the template's name in it — the English screen's pattern keeps the name)
const startedFrom = computed(() => (c.value.template ? `템플릿 「${c.value.template.name}」${ro(c.value.template.name)} 시작해요` : ''))
async function make() {
  if (busy.value) return
  const title = draft.value.title.trim()
  if (!title) { err.value = '프로젝트 이름을 적어 주세요.'; return }
  busy.value = true; err.value = ''
  const d = draft.value
  try {
    await app.makeProject(props.msg.id, { title, intent: d.intent.trim(), background: d.background.trim(), deliverables: d.deliverables.map((x) => x.text.trim()).filter(Boolean), template: picked.value })
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function no() {
  busy.value = true; err.value = ''
  try { await app.declineProject(props.msg.id) } catch (e) { err.value = e.message } finally { busy.value = false }
}
const open = () => c.value.project?.id && router.push(`/projects/${c.value.project.id}`)
</script>

<template>
  <div class="poff glass" data-test="project-offer" :data-state="state">
    <header>
      <span class="pi"><Icon name="folder" :size="17" /></span>
      <div class="ph">
        <b>{{ state === 'made' ? '프로젝트를 만들었어요' : state === 'declined' ? '프로젝트를 만들지 않았어요' : '프로젝트로 시작할까요?' }}</b>
        <small v-if="state === 'offered' || state === 'making'">아직 만들지 않았어요 · 이름과 템플릿을 확인하고 「만들기」를 눌러 주세요</small>
      </div>
    </header>

    <template v-if="state === 'offered' || state === 'making'">
      <p v-if="stale" class="stale" data-test="offer-stale">만들다가 멈췄어요 · 다시 만들거나 닫을 수 있어요</p>
      <label class="fl"><span>이름</span>
        <input v-model="draft.title" maxlength="60" data-test="offer-title" :disabled="busy" data-no-i18n @input="touch" />
      </label>
      <!-- what goes into the project's plan: as shown here, changed or not -->
      <div class="fields" data-test="offer-fields">
        <label class="fd"><span>목적</span>
          <textarea v-model="draft.intent" rows="2" maxlength="200" placeholder="이 프로젝트에서 할 일" data-test="offer-intent" :disabled="busy" data-no-i18n @input="touch" />
        </label>
        <div class="fd" data-test="offer-deliverables"><span>만들 것</span>
          <div class="items">
            <div v-for="(x, i) in draft.deliverables" :key="i" class="item">
              <input v-model="x.text" maxlength="80" data-test="offer-deliverable" :disabled="busy" data-no-i18n @input="touch" />
              <button class="rm press" aria-label="빼기" data-test="offer-deliverable-remove" :disabled="busy" @click="dropItem(i)"><Icon name="close" :size="13" /></button>
            </div>
            <button v-if="draft.deliverables.length < 5" class="add press" data-test="offer-deliverable-add" :disabled="busy" @click="addItem"><Icon name="plus" :size="13" /> 만들 것을 더해요</button>
          </div>
        </div>
        <label class="fd"><span>배경</span>
          <input v-model="draft.background" maxlength="120" placeholder="어디서 시작한 일인지" data-test="offer-background" :disabled="busy" data-no-i18n @input="touch" />
        </label>
        <small class="hint">프로젝트 계획에 이대로 들어가요 · 고쳐도 돼요</small>
      </div>
      <dl class="facts">
        <template v-if="mailLine"><dt>출처</dt><dd data-test="offer-source" data-no-i18n>{{ mailLine }}</dd></template>
        <template v-if="c.source?.answer"><dt>첫 문서</dt><dd data-test="offer-doc"><span data-no-i18n>「{{ c.source.answer.title }}」</span> 답을 문서로 남겨요</dd></template>
      </dl>
      <!-- the template folders that fit (the judge's picks, each with why) — none at all: no row -->
      <section v-if="recs.length" class="tpls" data-test="offer-templates">
        <p class="cap">템플릿 폴더 추천 <small>템플릿을 고르면 해당 자료 · 양식 · 스킬로 시작해요</small></p>
        <button v-for="t in recs" :key="t.slug" class="tpl press" :class="{ on: picked === t.slug }" role="radio" :aria-checked="picked === t.slug" :disabled="busy"
          data-test="offer-template" :data-slug="t.slug" @click="picked = picked === t.slug ? null : t.slug">
          <span class="rd"><Icon v-if="picked === t.slug" name="check" :size="13" /></span>
          <span class="tt"><b data-no-i18n>{{ t.name }}</b><small data-test="offer-template-why" data-no-i18n>{{ t.why }}</small></span>
          <i class="tag">템플릿</i>
        </button>
        <button class="tpl press" :class="{ on: !picked }" role="radio" :aria-checked="!picked" :disabled="busy" data-test="offer-template-none" @click="picked = null">
          <span class="rd"><Icon v-if="!picked" name="check" :size="13" /></span>
          <span class="tt"><b>빈 프로젝트로</b><small>템플릿 없이 시작해요</small></span>
        </button>
      </section>
      <p v-if="err" class="err" role="alert" data-test="offer-error">{{ err }}</p>
      <footer>
        <button class="sub press" :disabled="busy" data-test="offer-no" @click="no">아니요</button>
        <button class="go press" :disabled="busy" data-test="offer-make" @click="make">{{ busy ? '만드는 중…' : '만들기' }}</button>
      </footer>
    </template>

    <!-- made: where it is, and the way there -->
    <div v-else-if="state === 'made'" class="done" data-test="offer-made" :data-project="c.project?.id">
      <p><b data-no-i18n>「{{ c.project?.title || c.title }}」</b><template v-if="startedFrom"> · <span data-test="offer-started-from">{{ startedFrom }}</span></template></p>
      <small>원래 대화는 그대로 있어요</small>
      <button class="go press" data-test="offer-open" @click="open">프로젝트 열기 <Icon name="chevron" :size="13" /></button>
    </div>
  </div>
</template>

<style scoped>
.poff { width: min(560px, 100%); box-sizing: border-box; border-radius: 22px; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; color: var(--text-primary); }
header { display: flex; align-items: flex-start; gap: 10px; }
.pi { width: 32px; height: 32px; border-radius: 11px; display: grid; place-items: center; background: var(--field-bg); flex: none; }
.ph { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ph b { font-size: 15px; font-weight: 600; }
.ph small { font-size: 12px; color: var(--text-secondary); line-height: 1.4; }
.fl { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--text-secondary); }
.fl span { flex: none; }
.fl input { flex: 1; min-width: 0; height: 36px; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 11px; background: var(--field-bg); color: var(--text-primary); font: inherit; font-size: 14.5px; padding: 0 11px; }
.fields { display: flex; flex-direction: column; gap: 6px; }
.fd { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--text-secondary); }
.fd > span { flex: none; width: 3.4em; padding-top: 8px; }
.fd textarea, .fd > input, .item input { flex: 1; min-width: 0; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 11px; background: var(--field-bg); color: var(--text-primary);
  font: inherit; font-size: 13.5px; padding: 7px 10px; }
.fd textarea { resize: vertical; line-height: 1.45; }
.items { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.item { display: flex; align-items: center; gap: 4px; }
.rm { flex: none; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: var(--text-secondary); }
.add { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; height: 28px; padding: 0 10px; border-radius: 14px; background: var(--field-bg); color: var(--text-primary); font-size: 12.5px; }
.hint { font-size: 11.5px; color: var(--text-tertiary); padding-left: calc(3.4em + 10px); }
.stale { margin: 0; font-size: 12.5px; color: var(--color-warning, #b26a00); }
.facts { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; font-size: 13px; line-height: 1.45; }
.facts dt { color: var(--text-secondary); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.tpls { display: flex; flex-direction: column; gap: 4px; }
.cap { margin: 2px 0 2px; font-size: 12.5px; font-weight: 600; color: var(--text-secondary); }
.cap small { font-weight: 400; color: var(--text-tertiary); margin-left: 4px; }
.tpl { display: flex; align-items: center; gap: 10px; width: 100%; padding: 8px 10px; border-radius: 14px; text-align: left; color: var(--text-primary); border: 1px solid var(--hairline); background: transparent; }
.tpl.on { border-color: var(--text-primary); background: var(--cell-bg, rgba(127, 127, 127, .08)); }
.rd { width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--text-tertiary); display: grid; place-items: center; flex: none; }
.tpl.on .rd { background: var(--text-primary); border-color: var(--text-primary); color: var(--ink-inverse, #fff); }
.tt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.tt b { font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.tt small { font-size: 12px; color: var(--text-secondary); line-height: 1.35; overflow-wrap: anywhere; }
.tag { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; background: var(--field-bg); color: var(--text-secondary); flex: none; }
footer { display: flex; justify-content: flex-end; gap: 8px; }
.go, .sub { height: 38px; padding: 0 18px; border-radius: 19px; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center; gap: 4px; }
.go { background: var(--text-primary); color: var(--ink-inverse, #fff); }
.sub { background: var(--field-bg); color: var(--text-primary); }
.go:disabled, .sub:disabled { opacity: .5; }
.err { margin: 0; color: var(--color-error, #c62828); font-size: 12.5px; overflow-wrap: anywhere; }
.done { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.done p { margin: 0; font-size: 14px; overflow-wrap: anywhere; }
.done small { font-size: 12px; color: var(--text-secondary); }
</style>
