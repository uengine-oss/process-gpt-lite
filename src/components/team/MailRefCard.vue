<script setup>
// A mail mentioned in a messenger message (server lib/mailMention.js). A mail belongs to its owner, so what each person sees is their own
// state of it (decorate):
//   mine      — the owner: 「열기」 opens their mail sheet; 「본문 공유」 lets this room read the body (「공유 그만두기」 takes it back)
//   shared    — the owner shared the body with the room: 「본문 보기」 shows it here, read only
//   summary   — everyone else: the sender, the subject, the date, the attachments' names — not the body; 「본문 보기 요청」 tells the owner
//   requested — asked: 「본문 보기를 요청했어요」
//   gone      — the mail's card is gone
// The owner can drag their own mention on like any mail (src/fileDrag.js): into the AI chat, another conversation.
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import { useTeam } from '../../stores/team.js'
import { startDrag, mailItem } from '../../fileDrag.js'

const props = defineProps({ m: Object, r: Object, i: Number })
const team = useTeam()
const busy = ref('')
const note = ref('')
const body = ref(null)       // the mail, read only, once 「본문 보기」 brought it
const st = computed(() => props.r.state?.card || (props.r.owner && props.m.mine ? 'mine' : 'summary'))
const when = computed(() => {
  const d = props.r.date && new Date(props.r.date)
  return d && !isNaN(d) ? d.toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''
})
const atts = computed(() => props.r.attachments || [])
async function act(what, fn) {
  busy.value = what; note.value = ''
  try { await fn() } catch (e) { note.value = e.message || '하지 못했어요.' } finally { busy.value = '' }
}
const open = () => act('open', async () => {
  const x = await team.openMailRef(props.m, props.i)
  if (x?.mail) body.value = x.mail
})
const request = () => act('req', () => team.requestRef(props.m, props.i))
const share = (on) => act('share', () => team.shareMailRef(props.m, props.i, on))
const drag = (e) => { if (st.value === 'mine') startDrag(e, [mailItem({ actionId: props.r.actionId, subject: props.r.subject, from: props.r.from })]); else e.preventDefault() }
</script>

<template>
  <div class="mref" :class="[st, { busy: !!busy }]" data-test="mail-ref" :data-state="st" :data-subject="r.subject" :draggable="st === 'mine'" @dragstart="drag">
    <div class="head">
      <span class="ic"><Icon name="mail" :size="16" /></span>
      <span class="meta">
        <b data-test="mail-ref-subject">{{ r.subject || '(제목 없음)' }}</b>
        <small data-test="mail-ref-from">{{ r.from }}<template v-if="r.domain && r.from !== r.domain"> · {{ r.domain }}</template><template v-if="when"> · {{ when }}</template></small>
      </span>
      <span class="tag">메일</span>
    </div>
    <p v-if="atts.length" class="line atts" data-test="mail-ref-atts"><Icon name="clip" :size="12" /><span>{{ atts.join(', ') }}</span></p>

    <!-- the owner -->
    <div v-if="st === 'mine'" class="line acts">
      <span class="who">{{ r.share === 'room' ? '이 대화방이 본문을 볼 수 있어요' : '다른 사람에게는 요약만 보여요' }}</span>
      <button class="act ghost press" :disabled="!!busy" data-test="mail-ref-share" @click="share(r.share !== 'room')">{{ busy === 'share' ? '바꾸는 중…' : r.share === 'room' ? '공유 그만두기' : '본문 공유' }}</button>
      <button class="act press" :disabled="!!busy" data-test="mail-ref-open" @click="open">{{ busy === 'open' ? '여는 중…' : '열기' }}</button>
    </div>
    <!-- the room, with the body shared -->
    <div v-else-if="st === 'shared' && !body" class="line acts">
      <span class="who">{{ r.ownerName ? `${r.ownerName}님이 본문을 공유했어요` : '본문을 공유받았어요' }}</span>
      <button class="act press" :disabled="!!busy" data-test="mail-ref-open" @click="open">{{ busy === 'open' ? '여는 중…' : '본문 보기' }}</button>
    </div>
    <!-- everyone else: the summary only -->
    <p v-else-if="st === 'summary'" class="line lock" data-test="mail-ref-summary">
      <Icon name="lock" :size="13" /><span>요약만 보여요 · 본문은 {{ r.ownerName ? `${r.ownerName}님` : '메일 주인' }}이 공유해야 볼 수 있어요</span>
      <button class="act press" :disabled="busy === 'req'" data-test="mail-ref-request" @click="request">{{ busy === 'req' ? '요청하는 중…' : '본문 보기 요청' }}</button>
    </p>
    <p v-else-if="st === 'requested'" class="line wait" data-test="mail-ref-requested"><Icon name="clock" :size="13" /><span>본문 보기를 요청했어요 · 공유되면 볼 수 있어요</span></p>
    <p v-else-if="st === 'gone'" class="line lock"><Icon name="alert" :size="13" /><span>이 메일은 이제 볼 수 없어요</span></p>

    <!-- the body, read only (shared with this room) -->
    <div v-if="body" class="body" data-test="mail-ref-body">
      <small>{{ body.address ? `${body.from} <${body.address}>` : body.from }}</small>
      <div class="text">{{ body.text }}</div>
      <button class="act ghost press" @click="body = null">접기</button>
    </div>
    <p v-if="note" class="line lock" role="status" data-test="mail-ref-note">{{ note }}</p>
  </div>
</template>

<style scoped>
.mref { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; padding: 7px; border-radius: 14px; background: rgba(127, 127, 127, .08); border: 1px solid rgba(122, 90, 245, .32); max-width: 100%; min-width: 0; }
.mref[draggable="true"] { cursor: grab; }
.mref.busy { opacity: .8; }
.head { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 1px; }
.ic { flex: none; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #fff; background: #7a5af5; }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.meta b { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta small { font-size: 11.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 8px; color: #7a5af5; background: rgba(122, 90, 245, .13); }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin: 0; padding: 2px 6px; font-size: 12px; line-height: 1.45; color: var(--text-secondary); }
.line span { min-width: 0; overflow-wrap: anywhere; }
.line > :deep(svg) { flex: none; }
.lock span, .wait span { flex: 1 1 180px; }
.atts span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.acts .who { flex: 1; }
.lock { color: var(--text-secondary); }
.wait { color: #7a5af5; }
.act { margin-left: auto; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12px; font-weight: 600; color: #fff; background: #7a5af5; }
.acts .act { margin-left: 0; }
.act.ghost { color: var(--text-primary); background: transparent; border: 1px solid var(--hairline); }
.act:disabled { opacity: .6; }
.body { display: flex; flex-direction: column; gap: 4px; margin: 2px 4px; padding: 8px 10px; border-radius: 10px; background: var(--field-bg); }
.body small { font-size: 11.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.body .text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.55; max-height: 18em; overflow: auto; }
.body .act { align-self: flex-end; }
</style>
