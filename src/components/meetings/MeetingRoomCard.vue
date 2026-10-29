<script setup>
// A meeting's record in the room (messages.pgpt.kind meeting*, written by lib/meetings/record.js):
// the meeting card (참여하기 while it runs), a 회의록 block of speaker turns, a material shown, and the
// final minutes (요약 · 결정 · 할 일 · 참여자 · 시간 · 띄운 자료 · 기록하지 않은 사람).
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useMeetings } from '../../stores/meetings.js'
import { useTeam } from '../../stores/team.js'
import { kindOf, kindLabel } from '../../artifacts.js'
import { useApp } from '../../stores/app.js'
import { langLabel } from '../../i18n/mainLangs.js'

const props = defineProps({ m: Object, title: String })
const mt = useMeetings()
const team = useTeam()
const router = useRouter()
const open = ref(false)
const mm = computed(() => props.m.meeting || {})
const lines = computed(() => mm.value.lines || [])
const shownLines = computed(() => (open.value ? lines.value : lines.value.slice(-6)))
const live = computed(() => props.m.kind === 'meeting' && mm.value.state === 'live')
const joined = computed(() => mt.m?.id === mm.value.id)
const hhmm = (d) => (d ? new Date(d).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')
const KIND = { file: '파일', process: '진행 상황', panel: '앱 데이터', folder: '폴더 문서', result: '에이전트 결과' }
const join = () => mt.openLobby(props.m.threadId, props.title)
// the record in my main language: a line said in another language reads translated (made in the meeting
// or now, team store tr), the minutes in mine (pgpt.meeting.tr) — the original one click away
const app = useApp()
const my = computed(() => app.me?.mainLang || 'ko')
const orig = computed(() => !!team.original[props.m.id])
const lineIdx = (l) => lines.value.indexOf(l)
const lineTr = (l) => (l.lang && l.lang !== my.value ? l.tr?.[my.value] || team.tr[props.m.id]?.lines?.[lineIdx(l)] || null : null)
const anyTr = computed(() => lines.value.some((l) => lineTr(l)))
const minTr = computed(() => {
  if (props.m.kind !== 'meeting-minutes' || (mm.value.lang || 'ko') === my.value) return null
  const t = mm.value.tr?.[my.value] || team.tr[props.m.id]?.minutes
  return t?.summary ? t : null
})
const summary = computed(() => (minTr.value && !orig.value ? minTr.value.summary : mm.value.summary))
const decisions = computed(() => (mm.value.decisions || []).map((d, i) => (minTr.value && !orig.value ? minTr.value.decisions?.[i] || d : d)))
const actionTitle = (a, i) => (minTr.value && !orig.value ? minTr.value.actions?.[i] || a.title : a.title)
const openFile = (a) => a.shareId && team.openShared(a.shareId, router)
function goto(uuid) {
  if (!uuid) return
  team.focus = uuid
  const el = document.querySelector(`[data-id="${uuid}"]`)
  if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1600) }
}
</script>

<template>
  <div :data-id="m.id" class="mrc" :class="m.kind" :data-test="m.kind">
    <!-- the meeting card -->
    <template v-if="m.kind === 'meeting'">
      <div class="row">
        <span class="ic" :class="{ live }">📹</span>
        <div class="tx">
          <b>{{ live ? `회의 중 · ${mm.count}명 참여` : '회의가 끝났어요' }}</b>
          <small>{{ live ? (mm.live || []).join(', ') : `${hhmm(mm.startedAt)}–${hhmm(mm.endedAt)} · 참여 ${(mm.people || []).length}명 (${(mm.people || []).join(', ')})` }}</small>
        </div>
        <button v-if="live && !joined" class="b main press" data-test="room-join" @click="join">참여하기</button>
        <span v-else-if="live" class="b on">참여 중</span>
      </div>
    </template>

    <!-- a 회의록 block -->
    <template v-else-if="m.kind === 'meeting-transcript'">
      <p class="hd">🎙 회의록 {{ mm.block }} <small>{{ hhmm(lines[0]?.at) }}–{{ hhmm(lines[lines.length - 1]?.at) }} · {{ lines.length }}줄</small></p>
      <button v-if="lines.length > 6 && !open" class="more press" @click="open = true">앞의 {{ lines.length - 6 }}줄 더 보기</button>
      <p v-for="(l, i) in shownLines" :key="i" class="ln" :data-lang="l.lang"><b>{{ l.speaker }}</b>
        <span v-if="lineTr(l) && !orig" data-no-i18n data-test="record-tr">{{ lineTr(l) }} <small class="o"><i>{{ langLabel(l.lang) }}</i> {{ l.text }}</small></span>
        <span v-else :data-no-i18n="lineTr(l) ? '' : null">{{ l.text }}</span>
      </p>
      <p v-if="anyTr" class="trl"><span>AI 번역</span><button class="press" data-test="record-original" @click="team.toggleOriginal(m.id)">{{ orig ? '번역 보기' : '원문 보기' }}</button></p>
    </template>

    <!-- a material shown -->
    <template v-else-if="m.kind === 'meeting-material'">
      <p class="hd">📎 회의 자료 · {{ KIND[mm.material?.kind] || '자료' }}</p>
      <p class="mt"><b>{{ mm.material?.title }}</b></p>
      <p class="why">{{ mm.material?.presentedBy ? `${mm.material.presentedBy}님이 모두에게 띄웠어요` : '도우미가 찾아 띄웠어요' }}{{ mm.material?.reason ? ` — ${mm.material.reason}` : '' }}</p>
      <div v-if="m.artifacts?.length" class="arts">
        <button v-for="a in m.artifacts" :key="a.name" class="art press" :disabled="!a.shareId" @click="openFile(a)">
          <span class="fic" :class="kindOf(a.name)">{{ kindLabel[kindOf(a.name)] || 'FILE' }}</span>{{ a.name }}
        </button>
      </div>
    </template>

    <!-- the final minutes -->
    <template v-else-if="m.kind === 'meeting-minutes'">
      <p class="hd big">📝 회의록 <small>{{ hhmm(mm.startedAt) }}–{{ hhmm(mm.endedAt) }} · {{ mm.minutes }}분 · {{ (mm.people || []).length }}명</small></p>
      <p class="ppl"><span>참여</span> <span data-no-i18n>{{ (mm.people || []).join(', ') }}</span></p>
      <p v-if="mm.declined?.length" class="dec">받아쓰기에 동의하지 않은 분: {{ mm.declined.join(', ') }} — 이분들의 말은 기록하지 않았어요.</p>
      <p class="sum" :data-no-i18n="minTr ? '' : null" data-test="minutes-summary">{{ summary }}</p>
      <template v-if="mm.decisions?.length"><p class="sub">결정</p><ul :data-no-i18n="minTr ? '' : null"><li v-for="(d, i) in decisions" :key="i">{{ d }}</li></ul></template>
      <template v-if="mm.actions?.length"><p class="sub">할 일</p><ul :data-no-i18n="minTr ? '' : null"><li v-for="(a, i) in mm.actions" :key="i">{{ actionTitle(a, i) }}<small v-if="a.owner"> · {{ a.owner }}</small></li></ul></template>
      <p v-if="minTr" class="trl"><span>AI 번역 · <b data-no-i18n>{{ langLabel(mm.lang || 'ko') }}</b></span><button class="press" data-test="minutes-original" @click="team.toggleOriginal(m.id)">{{ orig ? '번역 보기' : '원문 보기' }}</button></p>
      <template v-if="mm.materials?.length">
        <p class="sub">띄운 자료</p>
        <div class="chips"><button v-for="x in mm.materials" :key="x.id" class="chip press" :disabled="!x.roomCard" @click="goto(x.roomCard)">{{ KIND[x.kind] }} · {{ x.title }}</button></div>
      </template>
      <template v-if="mm.tasks?.length">
        <p class="sub">회의 중 맡긴 작업</p>
        <div class="chips"><button v-for="t in mm.tasks" :key="t.id" class="chip press" :disabled="!t.resultMessageId" @click="goto(t.resultMessageId)">{{ t.title }} · {{ t.state === 'done' ? '끝남' : t.state === 'failed' ? '실패' : '진행 중' }}</button></div>
      </template>
      <small class="by">{{ mm.by === 'model' ? '도우미가 받아쓴 내용으로 정리했어요' : '규칙으로 정리했어요' }} · 할 일은 아래 카드에서 바로 맡길 수 있어요</small>
    </template>
  </div>
</template>

<style scoped>
.mrc { align-self: stretch; margin: 4px 0; padding: 12px 14px; border-radius: 16px; background: rgba(127, 127, 127, .08); color: var(--text-primary); font-size: 14px; border: 1px solid rgba(127, 127, 127, .14); }
.mrc.meeting { background: rgba(122, 90, 245, .1); border-color: rgba(122, 90, 245, .3); }
.mrc.meeting-minutes { background: var(--composer-bg, #fff); border-color: rgba(122, 90, 245, .4); box-shadow: 0 6px 24px rgba(0, 0, 0, .06); }
.row { display: flex; align-items: center; gap: 10px; }
.ic { font-size: 22px; }
.ic.live { animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .5 } }
.tx { flex: 1; display: flex; flex-direction: column; }
.tx small { font-size: 12px; color: var(--text-secondary); }
.b { height: 32px; padding: 0 14px; border-radius: 16px; font-size: 13.5px; display: inline-flex; align-items: center; }
.b.main { background: #7a5af5; color: #fff; }
.b.on { background: rgba(60, 207, 145, .18); color: #0f8a5f; }
.hd { margin: 0 0 6px; font-weight: 600; font-size: 13.5px; }
.hd small { font-weight: 400; color: var(--text-tertiary); font-size: 12px; margin-left: 4px; }
.hd.big { font-size: 16px; }
.ln { margin: 3px 0; line-height: 1.5; font-size: 13.5px; }
.ln b { font-weight: 600; color: #3b5bdb; margin-right: 4px; }
.more { font-size: 12px; color: #7a5af5; margin-bottom: 4px; }
.ln .o { color: var(--text-tertiary); font-size: 12px; margin-left: 4px; }
.ln .o i { font-style: normal; font-size: 10.5px; padding: 0 5px; border-radius: 5px; background: rgba(127, 127, 127, .14); margin-right: 2px; }
.trl { display: flex; align-items: center; gap: 8px; margin: 6px 0 0; font-size: 11.5px; color: var(--text-secondary); }
.trl button { font-size: 11.5px; padding: 1px 8px; border-radius: 8px; background: rgba(127, 127, 127, .14); color: inherit; }
.mt { margin: 0; }
.why { margin: 4px 0 0; font-size: 12.5px; color: var(--text-secondary); }
.arts, .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.art { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px 0 4px; border-radius: 12px; background: #1d1d1f; color: #f5f5f7; font-size: 13px; }
.fic { flex: none; width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; font-size: 9.5px; font-weight: 700; color: #fff; background: #6b6b66; }
.fic.xls { background: #217346; } .fic.cad { background: #0b6f88; } .fic.hwp { background: #1f6fd1; } .fic.doc { background: #2b579a; } .fic.pdf { background: #d93025; }
.ppl { margin: 0; font-size: 13px; color: var(--text-secondary); }
.dec { margin: 4px 0 0; font-size: 12.5px; color: #c62828; }
.sum { margin: 10px 0 0; line-height: 1.55; }
.sub { margin: 10px 0 2px; font-size: 12.5px; font-weight: 600; color: #7a5af5; }
ul { margin: 0; padding-left: 18px; line-height: 1.55; }
ul small { color: var(--text-tertiary); }
.chip { height: 28px; padding: 0 11px; border-radius: 14px; font-size: 12.5px; background: rgba(122, 90, 245, .12); color: #5a3fd0; }
.chip:disabled { opacity: .6; }
.by { display: block; margin-top: 10px; font-size: 11.5px; color: var(--text-tertiary); }
</style>
