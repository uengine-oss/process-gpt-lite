<script setup>
import { ref, onMounted, watch } from 'vue'
import { marked } from 'marked'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { useRouter, useRoute } from 'vue-router'

// 예약된 작업: hark's scheduled-task list + detail (status, schedule, previous runs, run now).
// A row with a skill is a mission (deepagents skill run by pg_cron); others are plain prompts.
const app = useApp()
const router = useRouter()
const route = useRoute()
// a task runs a skill (mission), starts a process, or sends a prompt — all three keep a run history
// (failures included), can run now and pause
const managed = () => true
const kindOf = (s) => (s.skill ? `스킬 ${s.skill}` : s.process_id ? `프로세스 ${s.process_id}` : '프롬프트')
const items = ref([])
const open = ref(null)
const runs = ref([])
const md = (t) => marked.parse(String(t || '').replace(/</g, '&lt;'), { breaks: true })
const when = (d) => (d ? new Date(d).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const statusText = { running: '실행 중', done: '완료됨', failed: '실패' }

async function load() {
  items.value = await api('/schedules')
  if (open.value) runs.value = await api(`/missions/${open.value.id}/runs`)
}
onMounted(async () => {
  await load()
  // a "{작업} 관리" pill in chat opens its task directly
  const want = route.query.open && items.value.find((x) => x.id === route.query.open)
  if (want) show(want)
})
const nextText = (s) => (s.next_run ? new Date(s.next_run).toLocaleString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '일시정지됨')
const target = (s) => (s.thread_kind === 'project' ? `프로젝트 "${s.thread_title}"에 게시` : '채팅에 게시')
watch(() => app.missionTick, load)

async function show(s) {
  open.value = s
  runs.value = managed(s) ? await api(`/missions/${s.id}/runs`) : []
}
async function runNow() {
  await api(`/missions/${open.value.id}/run`, { method: 'POST' })
  setTimeout(load, 800)
}
// Which process-gpt agent type runs this task: deepagents, or cli-agent driving a CLI.
const agents = [
  { id: 'deepagents', label: 'Deep Agents' },
  { id: 'claude-code', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
]
const agentOf = (s) => (s.agent?.orch === 'cliagents' ? s.agent.cli || 'claude-code' : 'deepagents')
async function setAgent(id) {
  const r = await api(`/missions/${open.value.id}/agent`, { method: 'POST', body: { agent: id } })
  open.value = { ...open.value, agent: r.agent }
  load()
}
async function togglePause() {
  const r = await api(`/missions/${open.value.id}/pause`, { method: 'POST', body: { paused: !open.value.paused } })
  open.value = { ...open.value, paused: r.paused }
  load()
}
async function remove() {
  await api(`/schedules/${open.value.id}`, { method: 'DELETE' })
  open.value = null
  load()
}
</script>

<template>
  <div v-if="!open">
    <p class="cap">예약된 작업 {{ items.length }}개</p>
    <div v-if="items.length" class="list glass">
      <button v-for="s in items" :key="s.id" class="li" @click="show(s)">
        <div class="main">
          <b>{{ s.name }}<span v-if="s.paused" class="tag">일시정지</span></b>
          <small>Custom schedule ({{ s.cron }}) · {{ kindOf(s) }}</small>
          <small v-if="s.last_run_info" class="last">{{ statusText[s.last_run_info.status] }} – {{ when(s.last_run_info.started_at) }}</small>
        </div>
        <Icon name="chevron" :size="16" />
      </button>
    </div>
    <p v-else class="cap">채팅에서 "매일 아침 8시에 …"처럼 말하거나, 스킬을 저장할 때 주기를 정하면 여기에 추가돼요.</p>
  </div>

  <div v-else class="detail blur-in">
    <button class="back-link" @click="open = null"><Icon name="back" :size="16" /> 목록</button>
    <h2>{{ open.name }}</h2>
    <div class="list glass">
      <div class="row"><span>상태</span>
        <button v-if="managed(open)" class="switch" :class="{ on: !open.paused }" role="switch" :aria-checked="!open.paused" :aria-label="open.paused ? '다시 시작' : '일시정지'" @click="togglePause"><i /></button>
        <b v-else>{{ open.paused ? '일시정지' : '활성' }}</b>
      </div>
      <div class="row"><span>일정</span><b>Custom schedule ({{ open.cron }})<small class="next">다음 실행 {{ nextText(open) }}</small></b></div>
      <div class="row"><span>전달</span><b>{{ target(open) }}</b></div>
      <div v-if="open.skill" class="row"><span>스킬</span><b>{{ open.skill }}</b></div>
      <div v-if="open.process_id" class="row"><span>프로세스</span><b>{{ open.process_id }}</b></div>
      <div v-if="managed(open) && open.params && Object.keys(open.params).length" class="row"><span>입력</span><b class="mono">{{ JSON.stringify(open.params) }}</b></div>
      <div v-if="open.skill" class="row"><span>에이전트</span>
        <span class="seg"><button v-for="a in agents" :key="a.id" :class="{ on: agentOf(open) === a.id }" @click="setAgent(a.id)">{{ a.label }}</button></span>
      </div>
      <div v-if="open.skill" class="row"><span>알림</span><b>{{ { on_change: '바뀐 게 있을 때만', always: '매번', never: '보내지 않음' }[open.notify] }}</b></div>
    </div>
    <div v-if="managed(open)" class="actions">
      <button class="dark-btn" @click="runNow">지금 실행</button>
      <button class="pill-btn danger" @click="remove">삭제</button>
    </div>
    <button v-else class="pill-btn danger" @click="remove">삭제</button>

    <template v-if="managed(open)">
      <p class="cap">이전 실행</p>
      <div class="runs">
        <div v-for="r in runs" :key="r.id" class="run glass">
          <div class="rh"><b :class="r.status">{{ statusText[r.status] }}</b> – {{ when(r.started_at) }}<span v-if="r.result?.agent" class="tag">{{ agents.find((a) => a.id === r.result.agent)?.label || r.result.agent }}</span><span v-if="r.trigger === 'manual'" class="tag">수동</span><span v-if="r.changed" class="tag hi">변경 있음</span><span v-else-if="r.status === 'done' && r.changed === null && !open.process_id" class="tag" title="스킬이 결과 줄(MISSION_RESULT)을 남기지 않아 바뀐 게 있는지 알 수 없어요">변동 여부 모름</span><span v-else-if="r.status === 'done' && r.changed === false" class="tag">변동 없음</span></div>
          <div class="md" v-html="md(r.summary)" />
          <button v-if="r.result?.instId" class="inst" @click="router.push(`/projects/p/${encodeURIComponent(r.result.instId)}`)">인스턴스 보기 <Icon name="chevron" :size="13" /></button>
          <div v-if="r.result?.created?.length" class="created">
            <div v-for="(c, i) in r.result.created" :key="i"><Icon name="clock" :size="12" /> {{ c.date }} {{ c.summary }}</div>
          </div>
        </div>
        <p v-if="!runs.length" class="cap">아직 실행 기록이 없어요.</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 14px; }
.list { border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.li { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--hairline); text-align: left; }
.li:last-child { border-bottom: 0; }
.main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 450; display: flex; gap: 8px; align-items: center; }
.main small { color: var(--text-secondary); font-size: 13.5px; }
.main .last { color: var(--text-tertiary); font-size: 12.5px; }
.tag { font-size: 11.5px; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); font-weight: 400; margin-left: 6px; }
.tag.hi { background: color-mix(in srgb, var(--color-success) 25%, transparent); color: var(--text-primary); }
.back-link { display: inline-flex; align-items: center; gap: 4px; font-size: 14px; color: var(--text-secondary); margin-bottom: 8px; }
h2 { font-size: 26px; font-weight: 500; margin: 0 0 16px; letter-spacing: -0.02em; }
.row { display: flex; justify-content: space-between; gap: 16px; padding: 14px 0; border-bottom: 1px solid var(--hairline); font-size: 15px; }
.row:last-child { border-bottom: 0; }
.row span { color: var(--text-secondary); flex: none; }
.row b { display: flex; flex-direction: column; align-items: flex-end; }
.row b { font-weight: 450; text-align: right; }
.seg { display: inline-flex; gap: 4px; flex-wrap: wrap; justify-content: flex-end; }
.seg button { height: 28px; padding: 0 11px; border-radius: 9999px; background: var(--field-bg); font-size: 13px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.switch { width: 52px; height: 30px; border-radius: 9999px; background: var(--field-bg); position: relative; transition: background-color .25s; flex: none; }
.switch i { position: absolute; top: 3px; left: 3px; width: 24px; height: 24px; border-radius: 50%; background: #fff; box-shadow: 0 1px 4px rgba(0 0 0 / .25); transition: left .25s var(--spring); }
.switch.on { background: var(--ink); } .switch.on i { left: 25px; }
:root[data-theme="dark"] .switch.on { background: #f5f5f7; } :root[data-theme="dark"] .switch.on i { background: #1d1d1f; }
.next { display: block; font-size: 12.5px; color: var(--text-secondary); font-weight: 400; margin-top: 2px; }
.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; word-break: break-all; }
.actions { display: flex; gap: 8px; margin-bottom: 22px; flex-wrap: wrap; }
.dark-btn, .pill-btn { height: 40px; }
.danger { color: var(--color-error); }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.runs { display: flex; flex-direction: column; gap: 10px; }
.run { border-radius: 18px; padding: 14px 16px; }
.rh { font-size: 13.5px; color: var(--text-secondary); margin-bottom: 6px; display: flex; align-items: center; flex-wrap: wrap; }
.rh b { font-weight: 500; color: var(--text-primary); margin-right: 4px; }
.rh b.failed { color: var(--color-error); }
.rh b.running { animation: pulse 1.6s infinite; }
.md { font-size: 14.5px; line-height: 1.55; }
.md :deep(p) { margin: 0 0 .4em; } .md :deep(table) { border-collapse: collapse; font-size: 13px; } .md :deep(td), .md :deep(th) { padding: 3px 6px; border-bottom: 1px solid var(--hairline); }
.inst { margin-top: 6px; display: inline-flex; align-items: center; gap: 2px; font-size: 13px; color: var(--text-secondary); text-decoration: underline; text-underline-offset: 3px; }
.created { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--text-secondary); }
.created div { display: flex; align-items: center; gap: 6px; }
</style>
