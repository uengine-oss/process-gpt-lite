<script setup>
// Top of the main chat: the conversations the context router told apart (hark keeps each piece
// of work in its own thread). Closed, a pill; open, the list; inside one, its title and the way
// back. The view is /chat/c/:cid, so a conversation can be linked and reopened. The same conversations as a list in the left column
// (or a sheet on a phone): 「대화 목록」 here, or 「채팅」 pressed twice (components/ThreadList.vue — spec chat-thread-list).
// In a project (the project prop) the same bar is the project's sub-topics (/projects/:id/t/:tid — src/projectTopics.js, spec
// project-room 「프로젝트 안의 주제」): shown once there are two or more, or one is open.
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import GradePicker from './context/GradePicker.vue'
import { useApp } from '../stores/app.js'
import { whenText, lastRequest, movable } from '../threadList.js'
import { hold as vHold } from './holdMenu.js'
import { topicPath, topicsShown } from '../projectTopics.js'
import { narrow, keyboardUp } from '../viewport.js'

const props = defineProps({ project: { type: Object, default: null } })
const app = useApp()
const router = useRouter()
const open = ref(false)
const inProject = computed(() => !!props.project?.id)
const list = computed(() => (inProject.value ? app.topicList : app.convList))
const filter = computed(() => (inProject.value ? app.topicFilter : app.convFilter))
// the words of each place (the main chat's are as they always were)
const W = computed(() => (inProject.value
  ? { back: '전체', unnamed: '주제', other: '다른 주제 ▾', otherName: '다른 주제', cap: '판단 모델이 이 프로젝트에서 나눈 주제', all: '전체 보기',
    pill: (n) => `주제 ${n}개 · 주제별로 보기`, inside: (n) => `이 주제의 메시지 ${n}개 · 여기서 물으면 이 주제에 이어져요`, short: (n) => `메시지 ${n}개` }
  : { back: '전체 대화', unnamed: '대화', other: '다른 대화 ▾', otherName: '다른 대화', cap: '판단 모델이 나눈 대화', all: '전체 대화 보기',
    pill: (n) => `대화 ${n}개 · 맥락별로 보기`, inside: (n) => `이 대화의 메시지 ${n}개 · 여기서 물으면 이 대화에 이어져요`, short: (n) => `메시지 ${n}개` }))
const cur = computed(() => list.value.find((c) => c.id === filter.value) || (filter.value ? { id: filter.value, title: W.value.unnamed, count: 0 } : null))
const shown = computed(() => !inProject.value || topicsShown(list.value, filter.value))
// Inside one conversation (or sub-topic) the bar stays at the top of the chat while it scrolls — a filtered view opens at its newest
// message, and the bar is what says which conversation this is (2026-11-28 07:24 recording: 「필터링해서 들어왔다는 그 모습이 여기 있기
// 때문에」). On a phone it is one strip (‹ · the name with its count under it · the grade · the folder 「프로젝트로 옮기기」 · 「다른 대화 ▾」 as its list icon); while typing there, the count and the
// grade fold away so the keyboard's short screen keeps its messages. The whole chat's bar (the pill) stays as it was.
const compact = computed(() => !!cur.value && narrow.value)
const typing = computed(() => compact.value && keyboardUp.value)
const when = (t) => whenText(t)
const firstLine = lastRequest
function go(c) {
  open.value = false
  if (inProject.value) router.push(topicPath(props.project.id, c?.id))
  else router.push(c ? `/chat/c/${encodeURIComponent(c.id)}` : '/chat')
}
// the list beside the chat (a sheet on a phone), kept open while one moves between conversations
function openList() { open.value = false; app.setThreadList(true) }
// 「프로젝트로 옮기기」: this whole conversation into a project (components/ConversationMoveSheet.vue — spec thread-to-project). Not a
// standing conversation (a scheduled task's, the briefs' — they keep arriving in the chat) nor an empty one: the server refuses those too.
// It sits on the bar itself, not only in 「다른 대화 ▾」 (2026-11-28 18:06 phone recording: 「… 프로젝트로 바꾸는 방법이 이런 헤더 부분에 어딘가
// 있거나 해야 …」, 「길게 누르기도 해보고 별걸 다 해봐도 어느 UI에서 지금 나오는 건지」 — the title and its count were tapped and held, and
// 「다른 대화」 does not read as 「옮기기」):
// a folder button beside the name, the name opens the bar's menu (its first row is this), and holding the name (a right-click) opens it
// straight away.
const canMove = computed(() => !inProject.value && !!filter.value && movable(cur.value))
function openMove() { open.value = false; app.moveSheet = { conv: cur.value.id, title: cur.value.title, count: cur.value.count } }
</script>

<template>
  <div v-if="shown" class="cbar" :class="{ inside: !!cur, compact, typing }" :data-scope="inProject ? 'project' : 'chat'" data-testid="cbar">
    <template v-if="cur">
      <button class="back press" data-testid="cbar-all" :aria-label="W.back" :title="W.back" @click="go(null)"><Icon name="back" :size="16" /> <span class="lbl">{{ W.back }}</span></button>
      <!-- the name: a tap opens the bar's menu (as 「다른 대화 ▾」 — the first row 「프로젝트로 옮기기」), a hold · right-click 「프로젝트로 옮기기」.
           Not a tab stop of its own: the keyboard has 「다른 대화 ▾」 (the same menu) and the folder (the move) beside it -->
      <button class="cur press" data-testid="cbar-current" :data-conv="cur.id" :title="`${cur.title} · ${W.inside(cur.count)}`" tabindex="-1" :aria-expanded="open"
        v-hold="canMove ? () => openMove() : null" data-hold-tap @click="open = !open">
        <b>{{ cur.title }}</b>
        <small data-testid="cbar-count">{{ compact ? W.short(cur.count) : W.inside(cur.count) }}</small>
      </button>
      <!-- 이 대화 맥락의 공개 등급(팀 맥락 공유) — 내 맥락이 아니거나 라우터가 아직 기록하지 않았으면 보이지 않는다 (메인 채팅만) -->
      <GradePicker v-if="!inProject" :conv="cur.id" :title="cur.title" compact />
      <!-- 「프로젝트로 옮기기」 in sight: the folder alone — the chat column is 512px at most, and the words squeezed the name to a few letters
           (its words: the tooltip, a screen reader's label, and the menu the name opens) -->
      <button v-if="canMove" class="mvb press" data-testid="cbar-move-btn" :aria-label="`「${cur.title}」 프로젝트로 옮기기`" title="프로젝트로 옮기기" @click="openMove">
        <Icon name="folder-move" :size="17" />
      </button>
      <!-- a phone: the list icon alone — the name opens the same menu, and the words (「Other conversations ▾」 in English) left the name two
           letters (PR #130 review) -->
      <button class="pill press" :class="{ icon: compact }" data-testid="cbar-other" :aria-expanded="open" :aria-label="compact ? W.otherName : undefined"
        :title="compact ? W.otherName : undefined" @click="open = !open">
        <Icon v-if="compact" name="plan" :size="16" /><template v-else>{{ W.other }}</template>
      </button>
    </template>
    <button v-else-if="list.length" class="pill press" data-testid="cbar-pill" @click="open = !open">
      <Icon name="plan" :size="15" /> {{ W.pill(list.length) }}
    </button>

    <Transition name="fade">
      <div v-if="open" class="panel glass" data-testid="cbar-panel" @click.stop>
        <!-- one conversation of the main chat open: it can go into a project as a whole (it then leaves the chat) -->
        <button v-if="canMove" class="row move press" data-testid="cbar-move" @click="openMove">
          <Icon name="folder-move" :size="16" /><span class="mv"><b>프로젝트로 옮기기</b><small>이 대화를 통째로 프로젝트로 옮겨요 · 채팅 목록에서는 빠져요</small></span>
        </button>
        <p class="cap">{{ W.cap }}</p>
        <button v-for="c in list" :key="c.id" class="row press" :class="{ on: c.id === filter }" data-testid="cbar-row" :data-conv="c.id" @click="go(c)">
          <div class="t"><b>{{ c.title }}</b><small>{{ when(c.updated_at) }} · {{ c.count }}개</small></div>
          <p v-if="c.gist || c.summary" class="s">{{ c.gist ? c.gist + ' · ' : '' }}{{ firstLine(c.summary) }}</p>
        </button>
        <button v-if="filter" class="row all press" data-testid="cbar-row-all" @click="go(null)">{{ W.all }}</button>
        <button v-if="!inProject && !app.threadListShown" class="row all list press" data-testid="cbar-open-list" @click="openList">
          <Icon name="plan" :size="14" /> 대화 목록 펼치기 <small>· 채팅 탭을 두 번 눌러도 돼요</small>
        </button>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* in the flow above the messages (the whole chat's pill scrolls away with them; inside one conversation the bar sticks — below) */
.cbar { position: relative; z-index: 6; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0 0 14px; }
/* inside one conversation the bar is a frosted strip, so messages scrolling under it do not show through — and it stays at the top of the
   chat (just under the top bar, 68px) while the conversation scrolls. The list's top padding (96px — ChatColumn .msgs) counts in a sticky
   offset: -24px is 72px from the column's top. (A positive offset pushed the bar down over the first message even at rest.) */
.cbar.inside { position: sticky; top: -24px; }
/* (a solid sheet under the blur: pinned over the messages, the composer's 55–62% let the bubbles under it show through — PR #125 review 4) */
.cbar.inside { padding: 6px; border-radius: 22px; background: var(--regular-solid-bg, var(--composer-bg)); -webkit-backdrop-filter: blur(40px) saturate(1.4); backdrop-filter: blur(40px) saturate(1.4); box-shadow: 0 6px 24px rgba(0, 0, 0, .10); }
.cbar.inside .cur { background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; padding: 2px 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13.5px; color: var(--text-primary); background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); box-shadow: 0 2px 10px rgba(0, 0, 0, .06); }
.back { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 12px; border-radius: 17px; font-size: 13.5px; background: #1d1d1f; color: #fff; }
/* (dark is the base theme: the solid pinned bar is near-black there, so the ‹ circle turns light to stay visible) */
:root:not([data-theme="light"]) .back { background: rgb(245 245 247); color: #1d1d1f; }
.cur { display: flex; flex-direction: column; min-width: 0; flex: 1; padding: 6px 12px; border-radius: 14px; background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); text-align: left; color: var(--text-primary); }
/* (held on a touch screen: the bar's own long press, not the system's text selection or callout — a mouse keeps its selection) */
@media (hover: none) { .cur { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; } }
.cur b { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cur small { color: var(--text-secondary); font-size: 12px; }
/* 「프로젝트로 옮기기」 on the bar: a round folder button, filled so it reads as one on the bar in either theme */
.mvb { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; padding: 0; border-radius: 17px; flex: none; color: var(--text-primary); background: rgba(127, 127, 127, .16); }
@media (hover: hover) { .mvb:hover { background: rgba(127, 127, 127, .26); } }
.panel { position: absolute; top: 42px; left: 0; width: min(520px, 100%); max-height: 60vh; overflow: auto; border-radius: 20px; padding: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .18); }
/* inside one conversation the bar is taller (a phone wraps it): the panel opens under it, on a solid sheet — the bar's own frosting is the
   only backdrop a panel inside it can blur, so the messages under it showed through (2026-11-28, the 「프로젝트로 옮기기」 row) */
.cbar.inside .panel { top: calc(100% + 6px); background: var(--regular-solid-bg, var(--regular-bg)); }
/* a phone: one line — ‹ alone, the name with its count under it, the grade chip, the folder and 「다른 대화 ▾」 small */
.cbar.compact { flex-wrap: nowrap; gap: 6px; padding: 4px; border-radius: 20px; }
.cbar.compact .back { width: 34px; padding: 0; justify-content: center; flex: none; }
.cbar.compact .back .lbl { display: none; }
/* (the count under the name, small — side by side, the folder button left the name three letters: 2026-11-28 18:06 recording round) */
.cbar.compact .cur { flex-direction: column; align-items: stretch; justify-content: center; gap: 0; padding: 0 2px; line-height: 1.2; min-width: 72px; }
.cbar.compact .cur b { min-width: 0; font-size: 14px; }
.cbar.compact .cur small { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 11px; }
.cbar.compact .pill { height: 32px; padding: 0 10px; font-size: 13px; flex: none; }
/* the folder and the list icon: round, 32px */
.cbar.compact .mvb, .cbar.compact .pill.icon { width: 32px; height: 32px; padding: 0; border-radius: 16px; justify-content: center; }
/* a long grade (「요약 공개 · 부서」 and 「민감 제안」) gives way before the name: its words end in 「…」, the name keeps 72px (PR #130 review) */
.cbar.compact :deep(.gp) { flex: 0 1 auto; min-width: 34px; }
.cbar.compact :deep(.gchip) { max-width: 100%; min-width: 0; overflow: hidden; }
.cbar.compact :deep(.gchip .badge) { flex: none; }
/* typing on a phone (the keyboard up): only ‹ · the name · 「다른 대화 ▾」 */
.cbar.typing .cur small, .cbar.typing :deep(.gp), .cbar.typing .mvb { display: none; }
.cap { margin: 6px 10px 6px; font-size: 12.5px; color: var(--text-secondary); }
.row { display: block; width: 100%; text-align: left; padding: 10px 12px; border-radius: 14px; color: var(--text-primary); }
.row:hover { background: rgba(0, 0, 0, .05); } .row.on { background: rgba(42, 120, 214, .12); }
.row .t { display: flex; align-items: baseline; gap: 8px; }
.row .t b { flex: 1; font-size: 14.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .t small { flex: none; color: var(--text-tertiary); font-size: 12px; }
.row .s { margin: 4px 0 0; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row.all { text-align: center; font-size: 13px; color: var(--text-secondary); }
.row.list { display: flex; align-items: center; justify-content: center; gap: 6px; flex-wrap: wrap; }
.row.list small { color: var(--text-tertiary); font-size: 12px; }
.row.move { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; background: var(--cell-bg, rgba(127, 127, 127, .08)); }
.row.move .mv { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.row.move b { font-size: 14px; font-weight: 600; }
.row.move small { font-size: 12px; color: var(--text-secondary); line-height: 1.35; }
</style>
