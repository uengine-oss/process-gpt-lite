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
import { whenText, lastRequest } from '../threadList.js'
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
  ? { back: '전체', unnamed: '주제', other: '다른 주제 ▾', cap: '판단 모델이 이 프로젝트에서 나눈 주제', all: '전체 보기',
    pill: (n) => `주제 ${n}개 · 주제별로 보기`, inside: (n) => `이 주제의 메시지 ${n}개 · 여기서 물으면 이 주제에 이어져요`, short: (n) => `메시지 ${n}개` }
  : { back: '전체 대화', unnamed: '대화', other: '다른 대화 ▾', cap: '판단 모델이 나눈 대화', all: '전체 대화 보기',
    pill: (n) => `대화 ${n}개 · 맥락별로 보기`, inside: (n) => `이 대화의 메시지 ${n}개 · 여기서 물으면 이 대화에 이어져요`, short: (n) => `메시지 ${n}개` }))
const cur = computed(() => list.value.find((c) => c.id === filter.value) || (filter.value ? { id: filter.value, title: W.value.unnamed, count: 0 } : null))
const shown = computed(() => !inProject.value || topicsShown(list.value, filter.value))
// Inside one conversation (or sub-topic) the bar stays at the top of the chat while it scrolls — a filtered view opens at its newest
// message, and the bar is what says which conversation this is (2026-11-28 07:24 recording: 「필터링해서 들어왔다는 그 모습이 여기 있기
// 때문에」). On a phone it is one line (‹ · the name · its count · the grade · 「다른 대화 ▾」); while typing there, the count and the
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
// 「프로젝트로 옮기기」: this whole conversation into a project (components/ConversationMoveSheet.vue — spec thread-to-project)
function openMove() { open.value = false; app.moveSheet = { conv: cur.value.id, title: cur.value.title, count: cur.value.count } }
</script>

<template>
  <div v-if="shown" class="cbar" :class="{ inside: !!cur, compact, typing }" :data-scope="inProject ? 'project' : 'chat'" data-testid="cbar">
    <template v-if="cur">
      <button class="back press" data-testid="cbar-all" :aria-label="W.back" :title="W.back" @click="go(null)"><Icon name="back" :size="16" /> <span class="lbl">{{ W.back }}</span></button>
      <div class="cur" data-testid="cbar-current" :data-conv="cur.id" :title="`${cur.title} · ${W.inside(cur.count)}`">
        <b>{{ cur.title }}</b>
        <small data-testid="cbar-count">{{ compact ? W.short(cur.count) : W.inside(cur.count) }}</small>
      </div>
      <!-- 이 대화 맥락의 공개 등급(팀 맥락 공유) — 내 맥락이 아니거나 라우터가 아직 기록하지 않았으면 보이지 않는다 (메인 채팅만) -->
      <GradePicker v-if="!inProject" :conv="cur.id" :title="cur.title" compact />
      <button class="pill press" data-testid="cbar-other" @click="open = !open">{{ W.other }}</button>
    </template>
    <button v-else-if="list.length" class="pill press" data-testid="cbar-pill" @click="open = !open">
      <Icon name="plan" :size="15" /> {{ W.pill(list.length) }}
    </button>

    <Transition name="fade">
      <div v-if="open" class="panel glass" data-testid="cbar-panel" @click.stop>
        <!-- one conversation of the main chat open: it can go into a project as a whole (it then leaves the chat) -->
        <button v-if="!inProject && filter && cur?.count" class="row move press" data-testid="cbar-move" @click="openMove">
          <Icon name="folder" :size="16" /><span class="mv"><b>프로젝트로 옮기기</b><small>이 대화를 통째로 프로젝트로 옮겨요 · 채팅 목록에서는 빠져요</small></span>
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
.cbar.inside { padding: 6px; border-radius: 22px; background: var(--composer-bg); -webkit-backdrop-filter: blur(40px) saturate(1.4); backdrop-filter: blur(40px) saturate(1.4); box-shadow: 0 6px 24px rgba(0, 0, 0, .10); }
.cbar.inside .cur { background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; padding: 2px 6px; }
.pill { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 14px; border-radius: 17px; font-size: 13.5px; color: var(--text-primary); background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); box-shadow: 0 2px 10px rgba(0, 0, 0, .06); }
.back { display: inline-flex; align-items: center; gap: 4px; height: 34px; padding: 0 12px; border-radius: 17px; font-size: 13.5px; background: #1d1d1f; color: #fff; }
.cur { display: flex; flex-direction: column; min-width: 0; flex: 1; padding: 6px 12px; border-radius: 14px; background: var(--composer-bg); -webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px); }
.cur b { font-size: 14.5px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cur small { color: var(--text-secondary); font-size: 12px; }
.panel { position: absolute; top: 42px; left: 0; width: min(520px, 100%); max-height: 60vh; overflow: auto; border-radius: 20px; padding: 8px; box-shadow: 0 16px 48px rgba(0, 0, 0, .18); }
/* inside one conversation the bar is taller (a phone wraps it): the panel opens under it, on a solid sheet — the bar's own frosting is the
   only backdrop a panel inside it can blur, so the messages under it showed through (2026-11-28, the 「프로젝트로 옮기기」 row) */
.cbar.inside .panel { top: calc(100% + 6px); background: var(--regular-solid-bg, var(--regular-bg)); }
/* a phone: one line — ‹ alone, the name and its count side by side, the grade chip and 「다른 대화 ▾」 small */
.cbar.compact { flex-wrap: nowrap; gap: 6px; padding: 4px; border-radius: 20px; }
.cbar.compact .back { width: 34px; padding: 0; justify-content: center; flex: none; }
.cbar.compact .back .lbl { display: none; }
.cbar.compact .cur { flex-direction: row; align-items: baseline; gap: 6px; padding: 0 2px; }
.cbar.compact .cur b { flex: 0 1 auto; min-width: 0; font-size: 14px; }
.cbar.compact .cur small { flex: none; white-space: nowrap; font-size: 12px; }
.cbar.compact .pill { height: 32px; padding: 0 10px; font-size: 13px; flex: none; }
.cbar.compact :deep(.gp) { flex: none; }
/* typing on a phone (the keyboard up): only ‹ · the name · 「다른 대화 ▾」 */
.cbar.typing .cur small, .cbar.typing :deep(.gp) { display: none; }
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
