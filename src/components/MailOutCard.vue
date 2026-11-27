<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// 「보낼 메일」 — a mail the agent wrote for the person (server lib/mailOut.js, the agent's send_mail_as_me). Nothing leaves until they press
// 보내기 here; it goes out from the mailbox THEY connected (the sender is read from the server every time, never taken from the card), and a
// reply goes in the thread of the mail it answers. No mailbox, or Gmail without permission to send: 연결하기 · 초안으로 두기.
// (2026-11-27 production: asked 「이렇게 보내」, the agent mailed a customer from the company's shared sending address, as a new mail)
const props = defineProps({ msg: Object })
const emit = defineEmits(['connect'])
const out = computed(() => props.msg.content?.mail_out || {})
const state = computed(() => out.value.state || 'pending')
const view = ref(null)
const editing = ref(false)
const draft = ref({ to: '', cc: '', subject: '', body: '' })
const busy = ref('')
const err = ref('')
const unfold = ref(false)
const long = computed(() => String(out.value.body || '').length > 420 || String(out.value.body || '').split('\n').length > 10)

async function load() {
  try { view.value = await api(`/mail-out/${encodeURIComponent(props.msg.id)}`); err.value = '' } catch (e) { err.value = e.message }
}
onMounted(load)
watch(state, load)
// connecting the mail happens in a sheet or another tab: the sender is read again when the page comes back to the front
const onFocus = () => { if (['pending', 'kept'].includes(state.value)) load() }
onMounted(() => { window.addEventListener('focus', onFocus); document.addEventListener('visibilitychange', onFocus) })
onBeforeUnmount(() => { window.removeEventListener('focus', onFocus); document.removeEventListener('visibilitychange', onFocus) })

const mode = computed(() => view.value?.mode || null)
const cantSend = computed(() => mode.value === 'connect' || mode.value === 'none')
const sendLabel = computed(() => (mode.value === 'drafts' ? '임시 보관함에 넣기' : '보내기'))
const thread = computed(() => out.value.reply || null)

function edit() {
  draft.value = { to: out.value.to || '', cc: out.value.cc || '', subject: out.value.subject || '', body: out.value.body || '' }
  editing.value = true
}
async function act(what, body) {
  busy.value = what
  err.value = ''
  try {
    await api(`/mail-out/${encodeURIComponent(props.msg.id)}/${what}`, { method: 'POST', ...(body ? { body } : {}) })
    if (what === 'send') editing.value = false
  } catch (e) {
    err.value = e.message
    // the mailbox changed under the card (disconnected, permission taken back): show what it is now
    if (['mail_not_connected', 'gmail_scope'].includes(e.code)) load()
  } finally { busy.value = '' }
}
const send = () => act('send', editing.value ? draft.value : {})
function connect() { emit('connect') }
</script>

<template>
  <!-- sent / put in Drafts -->
  <div v-if="state === 'sent' || state === 'drafted'" class="mo done glass" data-test="mail-out" :data-state="state">
    <Icon name="check" :size="18" />
    <div class="txt">
      <b data-test="mail-out-state">{{ state === 'drafted' ? '임시 보관함에 넣었어요 · 메일 앱에서 보내 주세요' : '보냈어요' }}</b>
      <small data-test="mail-out-sent"><span data-no-i18n>{{ out.sent?.from }}</span> → <span data-no-i18n>{{ out.sent?.to }}</span></small>
      <small><span data-no-i18n>{{ out.sent?.subject }}</span> · {{ out.sent?.thread ? '받은 메일의 스레드에 이어서' : '새 메일로' }}</small>
    </div>
  </div>
  <!-- dropped, or replaced by a corrected draft further down -->
  <div v-else-if="state === 'cancelled' || state === 'replaced'" class="mo gone" data-test="mail-out" :data-state="state">
    <Icon name="mail" :size="15" /> <span data-test="mail-out-state">{{ state === 'replaced' ? '고친 초안이 아래에 있어요' : '보내지 않기로 했어요' }}</span> · <span data-no-i18n>{{ out.subject }}</span>
  </div>
  <!-- kept as a draft: nothing left -->
  <div v-else-if="state === 'kept'" class="mo kept glass" data-test="mail-out" data-state="kept">
    <div class="h"><Icon name="mail" :size="17" /><b data-test="mail-out-state">초안으로 두었어요</b><span class="sub" data-no-i18n>{{ out.subject }}</span></div>
    <pre class="body folded" data-test="mail-out-body" data-no-i18n>{{ out.body }}</pre>
    <div class="row"><button class="pill-btn sm" :disabled="!!busy" data-test="mail-out-reopen" @click="act('reopen')">다시 열기</button></div>
  </div>
  <!-- pending (or being sent) -->
  <div v-else class="mo glass" data-test="mail-out" :data-state="state">
    <div class="h">
      <Icon name="mail" :size="17" /><b>보낼 메일</b>
      <span class="badge" data-test="mail-out-gate">{{ cantSend ? '아직 보낼 수 없어요' : `「${sendLabel}」를 눌러야 나가요` }}</span>
    </div>
    <div class="f" data-test="mail-out-from"><span>보낸 사람</span><b v-if="view?.from" data-no-i18n>{{ view.from }}</b><i v-else-if="view">연결된 내 메일이 없어요</i><i v-else>…</i></div>
    <template v-if="!editing">
      <div class="f" data-test="mail-out-to"><span>받는 사람</span><b data-no-i18n>{{ out.to || '—' }}</b></div>
      <div v-if="out.cc" class="f" data-test="mail-out-cc"><span>참조</span><b data-no-i18n>{{ out.cc }}</b></div>
      <div class="f" data-test="mail-out-subject"><span>제목</span><b data-no-i18n>{{ out.subject || '—' }}</b></div>
    </template>
    <template v-else>
      <label class="f"><span>받는 사람</span><input v-model="draft.to" data-test="mail-out-to-input" /></label>
      <label class="f"><span>참조</span><input v-model="draft.cc" data-test="mail-out-cc-input" /></label>
      <label class="f"><span>제목</span><input v-model="draft.subject" data-test="mail-out-subject-input" /></label>
    </template>
    <div class="f" data-test="mail-out-thread"><span>스레드</span>
      <b v-if="thread"><span data-no-i18n>「{{ thread.subject }}」</span>에 이어서<small v-if="thread.from" data-no-i18n> · {{ thread.from }}</small></b>
      <i v-else>새 메일 — 답장할 받은 메일을 찾지 못했어요</i>
    </div>
    <div v-if="(out.files || []).length || (out.missing || []).length" class="f files" data-test="mail-out-files"><span>첨부</span>
      <span class="chips">
        <span v-for="f in out.files" :key="f.messageId" class="chip" data-no-i18n><Icon name="clip" :size="13" /> {{ f.name }}</span>
        <span v-for="n in out.missing" :key="n" class="chip bad" data-test="mail-out-missing"><span data-no-i18n>{{ n }}</span> · 찾지 못해서 빼고 보내요</span>
      </span>
    </div>
    <textarea v-if="editing" v-model="draft.body" class="text-in" rows="10" data-test="mail-out-body-input" />
    <template v-else>
      <pre class="body" :class="{ folded: long && !unfold }" data-test="mail-out-body" data-no-i18n>{{ out.body }}</pre>
      <button v-if="long" class="more press" @click="unfold = !unfold">{{ unfold ? '접기' : '본문 모두 보기' }}</button>
    </template>
    <p v-if="mode === 'connect'" class="notice" data-test="mail-out-notice">메일을 연결하면 내 계정으로 보낼 수 있어요.</p>
    <p v-else-if="mode === 'none'" class="notice" data-test="mail-out-notice">Gmail의 메일 전송 권한이 없어요. 메일을 다시 연결하면 내 계정으로 보낼 수 있어요.</p>
    <p v-else-if="view?.provider === 'demo'" class="hint" data-test="mail-out-notice">데모 메일함이라 실제로 보내지 않고 기록만 해요.</p>
    <p v-else-if="mode === 'drafts'" class="hint" data-test="mail-out-notice">이 메일함에서는 바로 보낼 수 없어서 임시 보관함에 넣어요. 메일 앱에서 보내 주세요.</p>
    <p v-if="err" class="err" data-test="mail-out-err">{{ err }}</p>
    <div class="row">
      <template v-if="cantSend">
        <button class="pill-btn sm" :disabled="!!busy" data-test="mail-out-keep" @click="act('keep')">초안으로 두기</button>
        <button class="dark-btn sm" :disabled="!!busy" data-test="mail-out-connect" @click="connect">{{ mode === 'none' ? '다시 연결하기' : '연결하기' }}</button>
      </template>
      <template v-else>
        <button class="pill-btn sm ghost" :disabled="!!busy || state === 'sending'" data-test="mail-out-cancel" @click="act('cancel')">그만두기</button>
        <button v-if="!editing" class="pill-btn sm" :disabled="!!busy || state === 'sending'" data-test="mail-out-edit" @click="edit">고치기</button>
        <button class="dark-btn sm" :disabled="!!busy || state === 'sending' || !view" data-test="mail-out-send" @click="send">
          {{ busy === 'send' || state === 'sending' ? '보내는 중…' : sendLabel }}
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.mo { width: 460px; max-width: 100%; box-sizing: border-box; border-radius: 22px; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 6px; --regular-bg: var(--bubble-agent-bg); }
.h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 15px; margin-bottom: 4px; }
.h .sub { color: var(--text-secondary); font-size: 13.5px; overflow-wrap: anywhere; }
.badge { margin-left: auto; font-size: 12px; color: var(--text-secondary); background: var(--chip-bg); border-radius: 9999px; padding: 3px 10px; }
.f { display: flex; align-items: baseline; gap: 10px; border-bottom: 1px solid var(--hairline); padding: 5px 0; font-size: 14px; min-width: 0; }
.f > span:first-child { flex: none; width: 64px; font-size: 12.5px; color: var(--text-secondary); }
.f b { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
.f b small { color: var(--text-secondary); font-weight: 400; }
.f i { font-style: normal; color: var(--text-secondary); font-size: 13.5px; }
.f input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14px; color: var(--text-primary); padding: 4px 0; outline: none; }
.files .chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; font-size: 12.5px; padding: 3px 10px; border-radius: 9999px; background: var(--field-bg); overflow-wrap: anywhere; }
.chip.bad { color: #c2410c; }
.body { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: 14px; line-height: 1.6; }
.body.folded { max-height: 200px; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
.more { align-self: flex-start; font-size: 13px; color: var(--text-secondary); padding: 2px 0; }
.text-in { width: 100%; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 14px; padding: 10px 12px; font: inherit; font-size: 14px; line-height: 1.6;
  background: var(--field-bg); color: var(--text-primary); resize: vertical; min-height: 180px; margin-top: 6px; }
.notice { margin: 6px 0 0; font-size: 13.5px; color: #c2410c; }
.hint { margin: 6px 0 0; font-size: 12.5px; color: var(--text-secondary); }
.err { margin: 4px 0 0; font-size: 13px; color: #c2410c; overflow-wrap: anywhere; }
.row { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.sm { height: 40px; padding: 0 16px; }
.ghost { background: transparent; }
.pill-btn:disabled, .dark-btn:disabled { opacity: .5; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.done { flex-direction: row; align-items: flex-start; gap: 10px; }
.done .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.done small { color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.gone { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); padding: 6px 12px; border-radius: 9999px; background: var(--chip-bg); max-width: 100%; overflow-wrap: anywhere; }
.kept .body { margin-top: 0; }
</style>
