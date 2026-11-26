<script setup>
// 다가오는 약속 on Home (server lib/agenda · routes/agenda.js, spec openspec/specs/agenda-reminders): the plans agreed in my team rooms and my
// mail for the next days, soonest first — when, what, where, and where it was said (a tap opens that message or that mail). Each has
// 「이건 아니에요」 (not a plan of mine: no reminders, and the reading is recorded as wrong) and, with Google Calendar connected, 「캘린더에
// 추가」. The reminders themselves come as notices (type 'agenda' — NotificationCard) on Home and the phone. 2026-11-26 사용자: 「메일에 뭐
// 어떤 날 모이기로 했으면 그 날짜 근처가 됐을 때 그 오늘 모임은 어디에서 하기로 했어요 뭐 이런 식으로 노티가 들어온단 말이야」.
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { useTeam } from '../stores/team.js'

const app = useApp()
const team = useTeam()
const items = computed(() => app.agenda?.items || [])
const canAdd = computed(() => ['google', 'demo'].includes(app.agenda?.calendar))
const busy = ref('')
const err = ref({})

// 「12/1」 · 「화」 (「Tue」): the day the plan is on, in the reader's language (the server's)
const badge = (x) => x.badge || { d: '', w: '' }
async function open(x) {
  const s = x.source || {}
  if (s.kind === 'room' && s.roomId) return team.openMessenger(s.roomId, s.messageId || undefined)
  if (s.kind === 'mail') {
    try { await app.openMailCard({ actionId: s.actionId, mailId: s.mailId }, 'home') } catch (e) { err.value = { ...err.value, [x.id]: e.message || '메일을 열지 못했어요' } }
  }
}
async function add(x) {
  busy.value = x.id
  err.value = { ...err.value, [x.id]: '' }
  try { await app.addAgendaToCalendar(x) } catch (e) { err.value = { ...err.value, [x.id]: e.message || '캘린더에 넣지 못했어요' } } finally { busy.value = '' }
}
</script>

<template>
  <section v-if="items.length" class="agenda glass" data-test="agenda-card">
    <header class="head">
      <span class="ic" aria-hidden="true"><Icon name="clock" :size="15" /></span>
      <b>다가오는 약속</b>
      <span class="n">{{ items.length }}</span>
    </header>
    <ul class="list">
      <li v-for="x in items" :key="x.id" class="it" :class="{ changed: x.changed }" data-test="agenda-item" :data-id="x.id">
        <div class="day" aria-hidden="true" data-no-i18n><b>{{ badge(x).d }}</b><small>{{ badge(x).w }}</small></div>
        <div class="main">
          <p class="title"><span data-no-i18n data-test="agenda-title">{{ x.title }}</span><i v-if="x.changed" class="tag">바뀜</i></p>
          <p class="when" data-no-i18n data-test="agenda-when">{{ x.when }}<template v-if="x.location"> · {{ x.location }}</template></p>
          <p v-if="x.peopleLine" class="sub" data-no-i18n>{{ x.peopleLine }}</p>
          <p v-if="x.bring" class="sub"><span>챙길 것</span> · <span data-no-i18n>{{ x.bring }}</span></p>
          <!-- a link by its domain; a mail's says who sent it — the sender's word, not Lite's (review #1: it is never in the notice text) -->
          <p v-if="x.link && x.linkHost" class="sub lnk" data-test="agenda-link">
            <a :href="x.link" target="_blank" rel="noopener noreferrer nofollow" :title="x.linkFrom ? '메일을 보낸 사람이 준 주소예요' : undefined"><span>링크</span> · <span data-no-i18n>{{ x.linkHost }}</span></a>
            <template v-if="x.linkFrom"> · <span>보낸 사람</span> <span data-no-i18n data-test="agenda-link-from">{{ x.linkFrom }}</span></template>
          </p>
          <button class="src press" :title="x.source.kind === 'room' ? '약속을 정한 메시지를 열어요' : '약속 메일을 열어요'" data-test="agenda-source" @click="open(x)">
            <Icon :name="x.source.kind === 'room' ? 'team' : 'mail'" :size="13" />
            <span class="lbl" data-no-i18n>{{ x.source.label }}</span>
            <Icon name="chevron" :size="12" />
          </button>
          <div class="btns">
            <template v-if="canAdd">
              <a v-if="x.calendar?.link" class="b press" :href="x.calendar.link" target="_blank" rel="noopener" data-test="agenda-in-calendar">캘린더에 있어요</a>
              <span v-else-if="x.calendar" class="b done" data-test="agenda-in-calendar">{{ x.calendar.via === 'demo' ? '캘린더에 기록했어요' : '캘린더에 있어요' }}</span>
              <button v-else class="b press" :disabled="busy === x.id" data-test="agenda-calendar" @click="add(x)">{{ busy === x.id ? '추가 중…' : '캘린더에 추가' }}</button>
            </template>
            <button class="b ghost press" title="이 약속은 알리지 않아요" data-test="agenda-dismiss" @click="app.dismissAgenda(x)">이건 아니에요</button>
          </div>
          <small v-if="err[x.id]" class="err" role="status">{{ err[x.id] }}</small>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.agenda { border-radius: 24px; padding: 14px 16px 6px 18px; color: var(--text-primary); min-width: 0; max-width: 100%; overflow: hidden; }
.head { display: flex; align-items: center; gap: 8px; }
.head b { font-weight: 500; font-size: 15.5px; }
.ic { flex: none; width: 24px; height: 24px; border-radius: 9999px; display: grid; place-items: center; background: #0f8a7e; color: #fff; }
.n { margin-left: auto; min-width: 22px; height: 22px; line-height: 22px; padding: 0 7px; border-radius: 11px; background: rgba(0, 0, 0, .06); color: var(--text-secondary); font-size: 12.5px; text-align: center; }
.list { list-style: none; margin: 8px 0 0; padding: 0; }
.it { display: flex; gap: 12px; padding: 12px 0; border-top: 1px solid var(--hairline); min-width: 0; }
.it:first-child { border-top: 0; }
.day { flex: none; width: 46px; height: 50px; border-radius: 12px; display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(15, 138, 126, .1); color: #0b6f66; }
.day b { font-size: 15px; font-weight: 600; line-height: 1.2; }
.day small { font-size: 12px; line-height: 1.3; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.title { margin: 0; font-size: 15.5px; font-weight: 500; line-height: 1.4; overflow-wrap: anywhere; display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; }
.tag { font-style: normal; font-size: 11.5px; font-weight: 500; padding: 1px 7px; border-radius: 8px; background: var(--color-attention); color: #fff; }
.when { margin: 0; font-size: 14px; line-height: 1.5; color: var(--text-primary); overflow-wrap: anywhere; }
.sub { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); overflow-wrap: anywhere; }
.src { align-self: flex-start; max-width: 100%; display: inline-flex; align-items: center; gap: 5px; margin-top: 2px; padding: 3px 10px 3px 8px; border-radius: 12px;
  background: rgba(0, 0, 0, .05); color: var(--text-secondary); font-size: 12.5px; min-width: 0; }
.src .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btns { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 6px; }
.b { height: 32px; line-height: 32px; padding: 0 14px; border-radius: 16px; font-size: 13.5px; background: rgba(0, 0, 0, .06); color: var(--text-primary); text-decoration: none; }
.b.ghost { background: transparent; color: var(--text-secondary); padding: 0 8px; }
.b.done { background: transparent; color: #0b6f66; padding: 0 4px; }
.b:disabled { opacity: .55; }
.err { color: var(--color-error); font-size: 12.5px; overflow-wrap: anywhere; }
.lnk a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
/* (Lite always says its theme on <html data-theme> — stores/sky.js) */
:root[data-theme="dark"] .day { background: rgba(45, 212, 191, .14); color: #7ee8da; }
:root[data-theme="dark"] .n, :root[data-theme="dark"] .src, :root[data-theme="dark"] .b:not(.ghost):not(.done) { background: rgba(255, 255, 255, .1); }
:root[data-theme="dark"] .b.done { color: #7ee8da; }
</style>
