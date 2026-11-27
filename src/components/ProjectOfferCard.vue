<script setup>
// 「프로젝트로 시작할까요?」 — 대화를 진짜 Lite 프로젝트로 (2026-11-27 22:33 휴대폰 녹화: 「여기로 프로젝트로 승격하겠다는 거거든」 · 「이 프로젝트에 폴더 적절한
// 이 템플릿 폴더가 좀 우리가 추천이 좀 필요할 수도 있고」 — spec chat-to-project, server lib/chatProject.js). The card the chat shows when the person
// said so in words (the router's start_project) or pressed 「프로젝트로 시작」 on an answer: the name (theirs to change), what the project is for and
// where it came from, the answer that becomes its first document, the template folders that fit — each with why — and 「빈 프로젝트로」.
// 「만들기」 makes it (a template: through the template's own 「템플릿으로 시작」 — the project's own workspace); 「아니요」 makes nothing.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { ro } from '../josa.js'

const props = defineProps({ msg: Object })
const app = useApp()
const router = useRouter()
const c = computed(() => props.msg.content || {})
const name = ref(c.value.title || '')
let touched = false
watch(() => c.value.title, (t) => { if (c.value.state === 'offered' && !touched) name.value = t || '' })
const picked = ref(null)       // a template's slug, or null: an empty project
const busy = ref(false)
const err = ref('')
const recs = computed(() => (Array.isArray(c.value.templates) ? c.value.templates : []))
const state = computed(() => (busy.value ? 'making' : c.value.state || 'offered'))
const mailLine = computed(() => (c.value.source?.mail ? `받은 메일 「${c.value.source.mail.subject}」${c.value.source.mail.from ? ` · ${c.value.source.mail.from}` : ''}` : ''))
async function make() {
  if (busy.value) return
  const title = name.value.trim()
  if (!title) { err.value = '프로젝트 이름을 적어 주세요.'; return }
  busy.value = true; err.value = ''
  try { await app.makeProject(props.msg.id, { title, template: picked.value }) } catch (e) { err.value = e.message } finally { busy.value = false }
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
      <label class="fl"><span>이름</span>
        <input v-model="name" maxlength="60" data-test="offer-title" :disabled="busy" data-no-i18n @input="touched = true" />
      </label>
      <dl class="facts">
        <template v-if="c.intent"><dt>목적</dt><dd data-test="offer-intent" data-no-i18n>{{ c.intent }}</dd></template>
        <template v-if="c.background"><dt>배경</dt><dd data-test="offer-background" data-no-i18n>{{ c.background }}</dd></template>
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
      <p><b data-no-i18n>「{{ c.project?.title || c.title }}」</b><template v-if="c.template"> · 템플릿 <span data-no-i18n>「{{ c.template.name }}」</span>{{ ro(c.template.name) }} 시작해요</template></p>
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
