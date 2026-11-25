<script setup>
// An attachment of a mail mentioned in a messenger message (server lib/mailAttachments.js). The file belongs to the mail's owner, so what each
// person sees is their own state of it (decorate — the owner's card decides, for this room):
//   mine      — the owner: 「열기」 opens it as from their mail sheet; 「파일 공유」 lets this room open it (「공유 그만두기」 takes it back)
//   shared    — the owner shared it with the room: 「열기」, read only (a document in the editor, a picture · sound · video in the viewer,
//               anything else a 「내려받기」)
//   summary   — everyone else: the file's name and the mail's sender and subject, never the file; 「열기 요청」 tells the owner
//   requested — asked: 「열기를 요청했어요」
//   gone      — the mail's card is gone
// The owner can drag their own mention on, like the chip on the mail sheet (src/fileDrag.js): into the AI chat, another conversation.
import { computed, ref } from 'vue'
import Icon from '../Icon.vue'
import { useTeam } from '../../stores/team.js'
import { startDrag } from '../../fileDrag.js'
import { attBadge, sizeText } from '../../mailAttach.js'

const props = defineProps({ m: Object, r: Object, i: Number })
const team = useTeam()
const busy = ref('')
const note = ref('')
const dl = ref('')            // a 「내려받기」 address (a file the app does not open)
const st = computed(() => props.r.state?.card || (props.r.owner && props.m.mine ? 'mine' : 'summary'))
async function act(what, fn) {
  busy.value = what; note.value = ''
  try { await fn() } catch (e) { note.value = e.message || '하지 못했어요.' } finally { busy.value = '' }
}
const open = () => act('open', async () => {
  dl.value = ''
  const x = await team.openMailAttRef(props.m, props.i)
  if (x?.how === 'download' && x.url) dl.value = x.url
})
const request = () => act('req', () => team.requestRef(props.m, props.i))
const share = (on) => act('share', () => team.shareMailRef(props.m, props.i, on))
const drag = (e) => {
  if (st.value !== 'mine') return e.preventDefault()
  startDrag(e, [{ src: 'mailatt', id: props.r.actionId, i: props.r.i, name: props.r.name, subject: props.r.subject, as: 'mailatt' }])
}
</script>

<template>
  <div class="aref" :class="[st, { busy: !!busy }]" data-test="mail-att-ref" :data-state="st" :data-file="r.name" :draggable="st === 'mine'" @dragstart="drag">
    <div class="head">
      <span class="ic">{{ attBadge(r.name) }}</span>
      <span class="meta">
        <b data-test="mail-att-ref-name">{{ r.name }}</b>
        <small data-test="mail-att-ref-mail">메일 「{{ r.subject || '(제목 없음)' }}」<template v-if="r.from"> · {{ r.from }}</template><template v-if="r.size"> · {{ sizeText(r.size) }}</template></small>
      </span>
      <span class="tag">메일 첨부</span>
    </div>

    <!-- the owner -->
    <div v-if="st === 'mine'" class="line acts">
      <span class="who">{{ r.share === 'room' ? '이 대화방이 이 파일을 열 수 있어요' : '다른 사람에게는 이름만 보여요' }}</span>
      <button class="act ghost press" :disabled="!!busy" data-test="mail-att-ref-share" @click="share(r.share !== 'room')">{{ busy === 'share' ? '바꾸는 중…' : r.share === 'room' ? '공유 그만두기' : '파일 공유' }}</button>
      <button class="act press" :disabled="!!busy" data-test="mail-att-ref-open" @click="open">{{ busy === 'open' ? '여는 중…' : '열기' }}</button>
    </div>
    <!-- the room, with the file shared -->
    <div v-else-if="st === 'shared'" class="line acts">
      <span class="who">{{ r.ownerName ? `${r.ownerName}님이 이 파일을 공유했어요` : '이 파일을 공유받았어요' }} · 읽기 전용</span>
      <button class="act press" :disabled="!!busy" data-test="mail-att-ref-open" @click="open">{{ busy === 'open' ? '여는 중…' : '열기' }}</button>
    </div>
    <!-- everyone else: the name only -->
    <p v-else-if="st === 'summary'" class="line lock" data-test="mail-att-ref-summary">
      <Icon name="lock" :size="13" /><span>이름만 보여요 · 파일은 {{ r.ownerName ? `${r.ownerName}님` : '메일 주인' }}이 공유해야 열 수 있어요</span>
      <button class="act press" :disabled="busy === 'req'" data-test="mail-att-ref-request" @click="request">{{ busy === 'req' ? '요청하는 중…' : '열기 요청' }}</button>
    </p>
    <p v-else-if="st === 'requested'" class="line wait" data-test="mail-att-ref-requested"><Icon name="clock" :size="13" /><span>열기를 요청했어요 · 공유되면 열 수 있어요</span></p>
    <p v-else-if="st === 'gone'" class="line lock"><Icon name="alert" :size="13" /><span>이 첨부는 이제 볼 수 없어요</span></p>

    <p v-if="dl" class="line calm" data-test="mail-att-ref-download"><span>앱 안에서 열지 않는 형식이에요</span><a class="act ghost" :href="dl" download><Icon name="down" :size="12" /> 내려받기</a></p>
    <p v-if="note" class="line lock" role="status" data-test="mail-att-ref-note">{{ note }}</p>
  </div>
</template>

<style scoped>
.aref { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; padding: 7px; border-radius: 14px; background: rgba(127, 127, 127, .08); border: 1px solid rgba(122, 90, 245, .32); max-width: 100%; min-width: 0; }
.aref[draggable="true"] { cursor: grab; }
.aref.busy { opacity: .8; }
.head { display: flex; align-items: center; gap: 9px; min-width: 0; padding: 1px; }
.ic { flex: none; width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; color: #fff; background: #217346; font-size: 9.5px; font-weight: 700; }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.meta b { font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meta small { font-size: 11.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: none; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 8px; color: #7a5af5; background: rgba(122, 90, 245, .13); }
.line { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin: 0; padding: 2px 6px; font-size: 12px; line-height: 1.45; color: var(--text-secondary); }
.line span { min-width: 0; overflow-wrap: anywhere; }
.line > :deep(svg) { flex: none; }
.lock span, .wait span { flex: 1 1 180px; }
.acts .who { flex: 1; }
.wait { color: #7a5af5; }
.calm span { flex: 1; }
.act { margin-left: auto; height: 26px; padding: 0 11px; border-radius: 13px; font-size: 12px; font-weight: 600; color: #fff; background: #7a5af5; display: inline-flex; align-items: center; gap: 4px; text-decoration: none; }
.acts .act { margin-left: 0; }
.act.ghost { color: var(--text-primary); background: transparent; border: 1px solid var(--hairline); }
.act:disabled { opacity: .6; }
</style>
