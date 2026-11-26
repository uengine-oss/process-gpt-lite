<script setup>
// 메일을 대화방에 (2026-11-27 사용자: 「메일이 왔을때 그걸 대화방에 공유하는 기능도 필요.」 — spec mail-room-share, server lib/mailRooms.js).
// In the mail sheet, under its row of follow-up actions:
//   · where the mail is shared now — each room with what it reads (요약만 · 본문 · 첨부), its 「앞으로 … 도 이 방에」 rule, or the rule that
//     brought it, each with its own 끄기 — shown whenever there is any
//   · 「대화방에 공유」 (the row's pill): the picker — the rooms the server suggests first, each with why (「지난번에도 … 메일을 올린 방」 ·
//     「메일을 같이 받은 …님이 있어요」 · the judge's pick), the others, the teammates with no conversation yet; then a word to say,
//     「본문도 공유」, 「첨부 파일도 공유」, 「앞으로 오는 메일도 이 방에 올리기」 (the thread · the sender · the company), and what the
//     room will see. Nothing is posted before 보내기.
import { computed, ref, watch } from 'vue'
import Icon from './Icon.vue'
import PersonAvatar from './PersonAvatar.vue'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'

const props = defineProps({ action: Object, open: Boolean })
const emit = defineEmits(['close', 'picked'])
const app = useApp()
const team = useTeam()

// ---------- where it is shared ----------
const shared = ref([])
const busyStop = ref('')
// the card's own record of its rooms (an automatic post, a share from another window changes it: read again)
const mark = computed(() => {
  const s = props.action?.source || {}
  return JSON.stringify([Object.keys(s.room_posts || {}), Object.keys(s.mail_share || {}), Object.keys(s.room_follow || {}), s.att_share || null])
})
async function loadShared() {
  const s = props.action?.source || {}
  if (!Object.keys(s.room_posts || {}).length && !Object.keys(s.mail_share || {}).length && !Object.keys(s.room_follow || {}).length) { shared.value = []; return }
  try { shared.value = (await app.mailRooms(props.action.id, { only: 'shared' })).shared } catch (e) { console.warn('[mail rooms]', e.message) }
}
watch(mark, loadShared, { immediate: true })
const reads = (x) => [x.body ? '본문 공유 중' : '요약만', x.files ? `첨부 ${x.files}개 공유 중` : ''].filter(Boolean).join(' · ')
async function stop(x, what) {
  busyStop.value = `${x.room}:${what}`
  err.value = ''
  try { shared.value = (await app.stopMailRoom(props.action.id, x.room, what)).shared } catch (e) { err.value = e.message }
  busyStop.value = ''
}
function openRoom(room) {
  emit('close')
  team.openMessenger(room)
}

// ---------- the picker ----------
const data = ref(null)
const loadErr = ref('')
const find = ref('')
const pick = ref(null)          // {room} | {person}
const note = ref('')
const body = ref(false)
const files = ref(false)
const follow = ref(false)
const by = ref('')
const busy = ref(false)
const err = ref('')
const sent = ref(null)          // {id, title}
watch(() => props.open, async (on) => {
  if (!on) return
  sent.value = null; err.value = ''; loadErr.value = ''
  if (data.value) return
  try {
    data.value = await app.mailRooms(props.action.id)
    by.value = data.value.choice || data.value.choices?.[0]?.by || ''
    if (data.value.shared) shared.value = data.value.shared
  } catch (e) { loadErr.value = e.message }
}, { immediate: true })
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '')
const hit = (s) => !find.value.trim() || norm(s).includes(norm(find.value))
const others = (r) => (r.members || []).filter((m) => m.id !== app.me?.id).map((m) => m.name).join(', ')
const rooms = computed(() => (data.value?.rooms || []).filter((r) => hit(r.title) || (r.members || []).some((m) => hit(m.name))))
const people = computed(() => (data.value?.people || []).filter((p) => hit(p.name) || hit(p.email)))
const pickTitle = computed(() => pick.value?.room?.title || pick.value?.person?.name || '')
const choice = computed(() => (data.value?.choices || []).find((c) => c.by === by.value) || null)
// what the room will see, said before 보내기 — a sentence each (the English screen translates each one)
const says = computed(() => [
  body.value ? `「${pickTitle.value}」에는 보낸 사람 · 제목 · 날짜와 본문이 보여요.` : `「${pickTitle.value}」에는 보낸 사람 · 제목 · 날짜 · 첨부 이름만 보여요.`,
  files.value && data.value?.files ? `첨부 파일 ${data.value.files}개도 열 수 있어요.` : '',
  follow.value && choice.value ? `앞으로 ${choice.value.label}도 이 방에 올려요.` : '',
  follow.value && choice.value && body.value ? '그 메일의 본문도 함께 보여요.' : '',
].filter(Boolean))
function choose(p) { pick.value = p; err.value = '' }
function back() { pick.value = null; err.value = '' }
function cancel() { pick.value = null; note.value = ''; body.value = false; files.value = false; follow.value = false; emit('picked', false) }
async function send() {
  if (busy.value || !pick.value) return
  busy.value = true
  err.value = ''
  try {
    const r = await app.shareMailToRoom(props.action.id, { ...(pick.value.room ? { room: pick.value.room.id } : { person: pick.value.person.id }), note: note.value,
      body: body.value, files: files.value, follow: follow.value && choice.value ? choice.value.by : null })
    sent.value = r.room
    shared.value = r.shared
    // a conversation made just now (a teammate picked) is in the list from now on
    data.value = null
    cancel()
  } catch (e) { err.value = e.message }
  busy.value = false
}
</script>

<template>
  <section class="rshare" data-test="mail-room-share">
    <!-- just sent: where it went -->
    <p v-if="sent" class="sent" data-test="room-sent" :data-room="sent.id">
      <Icon name="check" :size="15" /><span>「{{ sent.title || '대화방' }}」에 공유했어요</span>
      <button class="go press" data-test="room-open" @click="openRoom(sent.id)">방 열기 <Icon name="chevron" :size="12" /></button>
    </p>

    <!-- the picker -->
    <div v-if="open" class="picker" data-test="room-picker">
      <div class="head">
        <p class="cap">대화방에 공유</p>
        <button class="x press" aria-label="닫기" data-test="room-picker-close" @click="cancel"><Icon name="close" :size="15" /></button>
      </div>
      <p v-if="loadErr" class="err" data-test="room-load-error">{{ loadErr }}</p>
      <p v-else-if="!data" class="wait shimmer-text" data-test="room-loading">알맞은 대화방을 찾는 중…</p>
      <template v-else-if="!pick">
        <label class="find"><Icon name="search" :size="14" /><input v-model="find" placeholder="대화방이나 팀원 찾기" autocomplete="off" data-test="room-find" /></label>
        <div class="list" role="listbox" aria-label="대화방">
          <button v-for="r in rooms" :key="r.id" class="opt press" :class="{ sug: r.suggested }" role="option" data-test="room-option" :data-room="r.id"
            :data-suggested="r.suggested ? '' : null" @click="choose({ room: r })">
            <PersonAvatar v-if="r.kind !== 'direct'" kind="group" size="sm">{{ r.members.length }}</PersonAvatar>
            <PersonAvatar v-else :id="r.members.find((m) => m.id !== app.me?.id)?.id" :name="r.title" size="sm" />
            <span class="nm"><b>{{ r.title }}</b><small>{{ r.why[0]?.text || others(r) }}</small></span>
            <i v-if="r.suggested" class="tag" data-test="room-suggested">추천</i>
          </button>
          <p v-if="people.length" class="sub">팀원에게 바로</p>
          <button v-for="p in people" :key="p.id" class="opt press" role="option" data-test="room-person" :data-person="p.id" @click="choose({ person: p })">
            <PersonAvatar :id="p.id" :name="p.name" size="sm" />
            <span class="nm"><b>{{ p.name }}</b><small>새 대화</small></span>
          </button>
          <p v-if="!rooms.length && !people.length" class="none" data-test="room-none">{{ find ? '찾는 대화방이나 팀원이 없어요.' : '아직 대화방이 없어요. 팀원을 골라 새 대화로 보낼 수 있어요.' }}</p>
        </div>
      </template>
      <template v-else>
        <div class="to" data-test="room-to">
          <span>받는 곳</span><b>{{ pickTitle }}</b>
          <button class="chg press" data-test="room-change" @click="back">바꾸기</button>
        </div>
        <textarea v-model="note" class="note" rows="2" maxlength="1000" placeholder="한마디 적기 (없어도 돼요)" data-test="room-note" />
        <label class="tg"><input v-model="body" type="checkbox" data-test="room-body" /><span>본문도 공유</span></label>
        <label v-if="data.files" class="tg"><input v-model="files" type="checkbox" data-test="room-files" /><span>첨부 파일도 공유 ({{ data.files }}개)</span></label>
        <label v-if="data.choices?.length" class="tg"><input v-model="follow" type="checkbox" data-test="room-follow" /><span>앞으로 오는 메일도 이 방에 올리기</span></label>
        <div v-if="follow && data.choices?.length" class="by" role="radiogroup" aria-label="어떤 메일을 올릴까요">
          <button v-for="c in data.choices" :key="c.by" class="chip press" :class="{ on: by === c.by }" role="radio" :aria-checked="by === c.by" data-test="room-follow-by" :data-by="c.by" @click="by = c.by">{{ c.label }}</button>
        </div>
        <p class="say" data-test="room-says"><template v-for="(t, i) in says" :key="i">{{ i ? ' ' : '' }}<span>{{ t }}</span></template></p>
        <div class="row">
          <button class="pill-btn sm" data-test="room-cancel" @click="cancel">취소</button>
          <button class="dark-btn sm" data-test="room-send" :disabled="busy" @click="send">{{ busy ? '보내는 중…' : '보내기' }}</button>
        </div>
      </template>
    </div>

    <!-- where it is shared: each room, what it reads, its rule — and 끄기 -->
    <div v-if="shared.length" class="shared" data-test="room-shared">
      <p class="cap">공유한 대화방</p>
      <div v-for="x in shared" :key="x.room" class="line" data-test="room-shared-line" :data-room="x.room">
        <div class="top">
          <Icon name="team" :size="14" />
          <button class="nm press" data-test="room-shared-open" @click="openRoom(x.room)">{{ x.title || '대화방' }}</button>
          <small>{{ reads(x) }}</small>
          <button v-if="x.body" class="off press" data-test="room-stop-body" :disabled="!!busyStop" @click="stop(x, 'body')">{{ busyStop === `${x.room}:body` ? '끄는 중…' : '본문 끄기' }}</button>
          <button v-if="x.files" class="off press" data-test="room-stop-files" :disabled="!!busyStop" @click="stop(x, 'files')">{{ busyStop === `${x.room}:files` ? '끄는 중…' : '첨부 끄기' }}</button>
        </div>
        <p v-if="x.follow" class="rule" data-test="room-rule">
          <span>앞으로 {{ x.follow.label }}도 이 방에 올려요</span><span v-if="x.follow.body">본문도 함께 보여요</span>
          <button class="off press" data-test="room-stop-follow" :disabled="!!busyStop" @click="stop(x, 'follow')">{{ busyStop === `${x.room}:follow` ? '끄는 중…' : '그만 올리기' }}</button>
        </p>
        <p v-else-if="x.auto" class="rule" data-test="room-auto">
          <span>{{ x.auto.label }}이라 저절로 올라갔어요</span><span v-if="!x.auto.on">지금은 꺼 둔 약속이에요</span>
          <button v-if="x.auto.on" class="off press" data-test="room-stop-auto" :disabled="!!busyStop" @click="stop(x, 'follow')">{{ busyStop === `${x.room}:follow` ? '끄는 중…' : '그만 올리기' }}</button>
        </p>
      </div>
    </div>
    <p v-if="err" class="err" data-test="room-error">{{ err }}</p>
  </section>
</template>

<style scoped>
.rshare { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.rshare:empty { display: none; }
.cap { margin: 0; font-size: 12.5px; color: var(--text-secondary); letter-spacing: .02em; }
.picker { display: flex; flex-direction: column; gap: 8px; border-radius: 18px; padding: 10px 12px 12px; background: var(--field-bg); }
.head { display: flex; align-items: center; justify-content: space-between; }
.x { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; color: var(--text-secondary); }
.find { display: flex; align-items: center; gap: 6px; height: 38px; padding: 0 12px; border-radius: 9999px; background: var(--cell-bg); border: 1px solid var(--hairline); color: var(--text-secondary); }
.find input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14px; color: var(--text-primary); outline: none; }
.list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; overscroll-behavior: contain; }
.opt { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 6px 8px; border-radius: 14px; text-align: left; color: var(--text-primary); }
.opt:hover { background: var(--chip-bg); }
.opt.sug { background: var(--chip-bg); }
.nm { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.nm b { font-size: 14.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { flex: none; font-style: normal; font-size: 11.5px; padding: 2px 8px; border-radius: 9999px; color: var(--text-primary); border: 1px solid var(--hairline); }
.sub { margin: 8px 0 2px 8px; font-size: 12px; color: var(--text-tertiary); }
.none { margin: 6px 8px; font-size: 13px; color: var(--text-secondary); }
.to { display: flex; align-items: center; gap: 8px; font-size: 14px; min-width: 0; }
.to span { flex: none; font-size: 12.5px; color: var(--text-secondary); }
.to b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.chg { margin-left: auto; flex: none; font-size: 13px; color: var(--text-secondary); padding: 4px 6px; }
.note { width: 100%; box-sizing: border-box; border: 1px solid var(--hairline); border-radius: 14px; padding: 8px 12px; font: inherit; font-size: 14.5px; line-height: 1.5;
  background: var(--cell-bg); color: var(--text-primary); resize: vertical; }
.tg { display: flex; align-items: center; gap: 8px; font-size: 14px; color: var(--text-primary); min-height: 32px; }
.tg input { width: 18px; height: 18px; accent-color: var(--text-primary); flex: none; }
.by { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 26px; }
.chip { display: inline-flex; align-items: center; max-width: 100%; font-size: 12.5px; padding: 5px 11px; border-radius: 9999px; border: 1px solid var(--hairline); color: var(--text-secondary); overflow-wrap: anywhere; text-align: left; }
.chip.on { color: var(--text-primary); background: var(--chip-bg); border-color: var(--text-secondary); }
.say { margin: 2px 0 0; font-size: 12.5px; line-height: 1.55; color: var(--text-secondary); overflow-wrap: anywhere; word-break: keep-all; }
.row { display: flex; justify-content: flex-end; gap: 8px; }
.sm { height: 40px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.pill-btn:disabled, .dark-btn:disabled { opacity: .5; }
.sent { margin: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; padding: 8px 12px; border-radius: 14px; background: var(--chip-bg); font-size: 13.5px; }
.sent > :deep(svg) { flex: none; }
.go { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; font-size: 13px; color: var(--text-secondary); }
.shared { display: flex; flex-direction: column; gap: 4px; }
.line { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.top { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; min-width: 0; font-size: 13.5px; }
.top > :deep(svg) { flex: none; color: var(--text-secondary); }
.top .nm { flex: 0 1 auto; display: inline; font-weight: 600; color: var(--text-primary); overflow-wrap: anywhere; text-align: left; }
.top small { color: var(--text-secondary); font-size: 12.5px; }
.rule { margin: 0 0 0 22px; display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.off { height: 26px; padding: 0 11px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); border: 1px solid var(--hairline); }
.wait { margin: 0; font-size: 13.5px; color: var(--text-secondary); }
.err { margin: 0; font-size: 13px; color: #c2410c; overflow-wrap: anywhere; }
</style>
