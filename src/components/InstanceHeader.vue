<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { marked } from 'marked'
import { hidePaths } from '../paths.js'
import StepTimeline from './StepTimeline.vue'
import AgentActivity from './AgentActivity.vue'
import { auth, api } from '../api.js'
import TodoCard from './TodoCard.vue'
import LocalRunCard from './LocalRunCard.vue'
import BpmnView from './BpmnView.vue'
import Icon from './Icon.vue'
import OntoCaseFlow from './ontology/OntoCaseFlow.vue'
import OntoCaseRun from './ontology/OntoCaseRun.vue'
import OntoCaseManage from './ontology/OntoCaseManage.vue'
import { instanceViewOf, mapCaseOf, wideCardWidth } from './ontology/caseView.js'
import { BASE } from '../base.js'
import { useApp } from '../stores/app.js'
import { inApp, openOutput } from '../artifacts.js'
import DownloadButton from './DownloadButton.vue'

// Top of an instance page: title, live flow, my pending inputs, and produced artifacts.
// A case run straight from the company's process map (data.mapCase — server lib/ontology/mapengine.js) has no definition: its 진행 상황
// draws the case's own BPMN (OntoCaseFlow — lanes, splits and joins as a snapshot's, each step's state coloured, a legend) and opens on
// it; 목록 is the case's steps (OntoCaseRun steps — the same reading as the diagram's colours). Under it the case's controls (OntoCaseRun
// controls — 방식 · 멈추기 · 기다리는 단계의 진행 · 다른 갈래 · 멈추기), 「내 입력이 필요해요」 as for any instance, then 「이 건 다루기」(맡는
// 사람 · 지도 고정 · 다른 일로 옮기기). The company's map is a link (「회사 지도에서 이 건 보기」). On a wide page the diagram's card is wider
// than the conversation's column so the flow runs left to right; on a phone it is the column's width and runs top to bottom.
const props = defineProps({ data: Object })
const emit = defineEmits(['refresh'])
const app = useApp()
const openDoc = ref(null)
const how = computed(() => instanceViewOf(props.data))
const mc = computed(() => mapCaseOf(props.data))
const view = ref(how.value.view)
watch(() => how.value.caseId || how.value.defId, () => { view.value = how.value.view })
const detail = ref(null)
// a change on the map case (a gate decided, a step handed in or moved, a role given to someone): the diagram, its controls and the
// instance read again
const tick = ref(0)
const ctlRef = ref(null)
const manageRef = ref(null)
function caseChanged() { tick.value++; ctlRef.value?.reload?.(); emit('refresh') }
function submitted() { if (mc.value) { caseChanged(); manageRef.value?.reload?.() } else emit('refresh') }
// the room the conversation's scroller has (the diagram's card may be wider than the 512px column, centred over it)
const root = ref(null)
const room = ref(0)
let ro = null
onMounted(() => {
  const scroller = root.value?.closest('.msgs') || root.value?.parentElement?.parentElement
  if (!scroller) return
  room.value = scroller.clientWidth
  ro = new ResizeObserver(() => { room.value = scroller.clientWidth })
  ro.observe(scroller)
})
onBeforeUnmount(() => ro?.disconnect())
const cardW = computed(() => (mc.value ? wideCardWidth(room.value) : null))
// a <video> cannot send the bearer header, so the agent-file URL carries the token
const fileUrl = (a) => `${BASE}/api/agent-files/${encodeURIComponent(a.runId)}?path=${encodeURIComponent(a.path)}&token=${encodeURIComponent(auth.get()?.session?.access_token || '')}`
const i = computed(() => props.data.inst)
const wf = computed(() => props.data.workFolder || null)
const mine = computed(() => props.data.steps.filter((s) => s.mine && s.todoId))
const status = computed(() => ({ RUNNING: '진행 중', COMPLETED: '완료', NEW: '시작 전' }[i.value.status] || i.value.status))
const progress = computed(() => {
  const real = props.data.steps.filter((s) => s.kind === 'human' || s.kind === 'agent')
  return { done: real.filter((s) => s.state === 'done').length, all: real.length }
})
const retryErr = ref('')
// 「다시 시도」 on a failed agent step: back in the agent queue (server lib/stepRetry.js)
async function retry(s) {
  retryErr.value = ''
  try { await api(`/todos/${encodeURIComponent(s.todoId)}/retry`, { method: 'POST' }); emit('refresh') }
  catch (e) { retryErr.value = `다시 시도하지 못했어요. ${e.message.slice(0, 120)}` }
}
const md = (t) => marked.parse(hidePaths(t || '').replace(/</g, '&lt;'), { breaks: true })
const fieldLabel = (a) => a.label || a.field?.replace(/_/g, ' ')
const when = (d) => (d ? new Date(d).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
</script>

<template>
  <div ref="root" class="ih" :data-test="mc ? 'instance-map-case' : 'instance-definition'">
    <div class="title">
      <span class="pill" :class="i.status">{{ status }}</span>
      <h2 class="serif">{{ i.proc_inst_name || data.def?.name }}</h2>
      <p class="sub">{{ mc ? '지도에서 바로 도는 건' : data.def?.name }} · {{ when(i.start_date) }} 시작 · {{ progress.done }}/{{ progress.all }} 단계</p>
      <div class="bar"><span :style="{ width: (progress.all ? progress.done / progress.all * 100 : 0) + '%' }" /></div>
      <!-- a map case: its place on the company's map, for whoever wants the map's context (the flowchart here is the case's BPMN) -->
      <router-link v-if="mc" class="imp" :to="how.mapLink" data-test="map-case-map-link">회사 지도에서 이 건 보기 →</router-link>
      <router-link v-else class="imp" :to="`/improve/${encodeURIComponent(i.proc_def_id)}?tab=path`">이 프로세스의 병목·크리티컬 패스 보기 →</router-link>
    </div>

    <!-- the work's folder (server lib/mailWork.js): the mails of this work from the first one on, and what its steps made -->
    <div v-if="wf" class="wf" data-test="work-folder">
      <router-link class="wfl press" :to="`/folders/${encodeURIComponent(wf.slug)}`" data-test="work-folder-link">
        <span class="wfi"><Icon name="folder" :size="18" /></span>
        <span class="wft"><b>작업 폴더</b><small>{{ wf.name }}</small></span>
        <Icon name="chevron" :size="14" />
      </router-link>
      <p class="wfs" data-test="work-folder-sub">
        <span>메일 {{ wf.mails }}통</span><span>· 단계 결과 {{ wf.outputs }}개</span>
        <router-link v-if="wf.line" :to="`/folders/${encodeURIComponent(wf.slug)}/v/${wf.line.id}`" data-test="work-folder-line">· 단계 결과 보기 →</router-link>
      </p>
    </div>

    <!-- steps run by a CLI agent on their assignee's own computer (server lib/localAgents): waiting, running, done — and steering -->
    <div v-if="data.localRuns?.length" class="locals" data-test="local-runs">
      <div class="ch">로컬 에이전트 · 담당자의 컴퓨터에서 실행 <small v-if="data.localRuns.some((r) => r.canSteer)">· 이 대화에 쓰면 실행 중인 에이전트에게 전해져요</small></div>
      <LocalRunCard v-for="r in data.localRuns.slice(0, 4)" :key="r.jobId" :run="r" />
    </div>

    <div class="card" :class="{ wide: !!cardW }" :style="cardW ? { width: `${cardW}px` } : null" :data-test="mc ? 'map-case-card' : 'instance-card'" :data-view="view">
      <div class="ch row">진행 상황
        <span class="seg"><button :class="{ on: view === 'list' }" data-view="list" @click="view = 'list'">목록</button><button :class="{ on: view === 'bpmn' }" data-view="bpmn" @click="view = 'bpmn'">다이어그램</button></span>
      </div>
      <!-- a map case: its own BPMN (made from the map as it ran — no definition) or its steps, both from one reading of its work items -->
      <template v-if="mc">
        <OntoCaseFlow v-if="view === 'bpmn'" class="flow" :case-id="mc.id" :tick="tick" />
        <OntoCaseRun v-else class="steps" :case-id="mc.id" part="steps" :inline-todos="false" @changed="caseChanged" />
      </template>
      <template v-else>
        <StepTimeline v-if="view === 'list'" :steps="data.steps.filter((s) => s.kind !== 'event')" @detail="(s) => (detail = s)" @retry="retry" />
        <BpmnView v-else class="diagram" :def-id="data.inst.proc_def_id" :steps="data.steps" :height="380" />
        <p v-if="retryErr" class="rerr">{{ retryErr }}</p>
      </template>
    </div>

    <!-- a map case's controls: its mode, 멈추기 · 이어 가기, and a step waiting for a person (진행 · 다른 갈래 · 건너뛰기 · 멈추기) -->
    <div v-if="mc" class="card ctl" data-test="map-case-controls">
      <OntoCaseRun ref="ctlRef" :case-id="mc.id" part="controls" @changed="caseChanged" />
    </div>

    <div v-for="s in mine" :key="s.todoId" class="mine">
      <div class="ch attn"><Icon name="alert" :size="14" /> 내 입력이 필요해요</div>
      <TodoCard :todo-id="s.todoId" @submitted="submitted" />
    </div>

    <OntoCaseManage v-if="mc" ref="manageRef" :case-id="mc.id" @changed="caseChanged" />

    <template v-if="data.artifacts.length">
      <div class="ch out">산출물 {{ data.artifacts.length }}</div>
      <div class="arts">
        <template v-for="(a, k) in data.artifacts" :key="k">
          <!-- opens over this page (OfficeSheet, read-only), not as a download handed to another app -->
          <button v-if="a.kind === 'file' && inApp(a)" class="file press" @click="openOutput(app, a)"><Icon name="doc" :size="18" /> <span class="fn">{{ a.name }}</span></button>
          <!-- no viewer here: saved under its own name (DownloadButton — a refusal is said, a blocked tab offered as a link) -->
          <DownloadButton v-else-if="a.kind === 'file'" class="file" :label="`${a.name} 내려받기`" :source="{ url: a.url, name: a.name }"><Icon name="doc" :size="18" /> <span class="fn">{{ a.name }}</span></DownloadButton>
          <div v-else-if="a.kind === 'video'" class="video">
            <div class="dh"><span class="serif">구현 시연 영상</span><small>{{ a.activity }}</small></div>
            <video :src="fileUrl(a)" controls preload="metadata" playsinline />
          </div>
          <div v-else-if="a.kind === 'branch'" class="branch">
            <div class="dh"><span class="serif">제품 저장소 브랜치</span><small>{{ a.activity }}</small></div>
            <div class="bl"><code>{{ a.branch }}</code> · 커밋 <code>{{ a.commit }}</code> · 기준 {{ a.base }}</div>
            <div class="bs">{{ a.stat }}</div>
            <ul><li v-for="f in a.files.slice(0, 8)" :key="f"><code>{{ f.replace(/^[AMD]\t/, '') }}</code></li></ul>
            <div v-if="a.files.length > 8" class="bs">외 {{ a.files.length - 8 }}개 파일 · 병합은 사람이 검토 후에</div>
          </div>
          <div v-else class="doc" :class="{ open: openDoc === k }">
            <div class="dh"><span class="serif">{{ fieldLabel(a) }}</span><small>{{ a.activity }}</small></div>
            <div class="inner md" v-html="md(a.text)" />
            <button class="more press" :aria-label="openDoc === k ? '접기' : '펼치기'" @click="openDoc = openDoc === k ? null : k">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" :style="{ rotate: openDoc === k ? '180deg' : '0deg' }"><path d="M6 9l6 6 6-6" /></svg>
            </button>
          </div>
        </template>
      </div>
    </template>
    <div class="divider">이 프로세스에 대해 물어보세요</div>
    <AgentActivity v-if="detail" :step="data.steps.find((x) => x.id === detail.id) || detail" @close="detail = null" />
  </div>
</template>

<style scoped>
.ih { display: flex; flex-direction: column; gap: 14px; animation: blur-in .5s var(--spring) both; }
.title { padding: 6px 6px 4px; }
.pill { display: inline-flex; height: 24px; align-items: center; padding: 0 10px; border-radius: 9999px; font-size: 12px; font-weight: 500; background: var(--bubble-user-bg); }
.pill.RUNNING { background: color-mix(in srgb, var(--color-info) 22%, transparent); }
.pill.COMPLETED { background: color-mix(in srgb, var(--color-success) 26%, transparent); }
h2 { font-size: 30px; font-weight: 300; line-height: 1.25; margin: 10px 0 6px; letter-spacing: .005em; }
.sub { margin: 0 0 12px; font-size: 14px; color: var(--text-secondary); }
.bar { height: 4px; border-radius: 4px; background: var(--hairline); overflow: hidden; }
.bar span { display: block; height: 100%; background: var(--text-primary); border-radius: 4px; transition: width .8s var(--spring); }
.locals { display: flex; flex-direction: column; gap: 8px; }
.locals .ch small { color: var(--text-tertiary); }
.rerr { color: var(--color-error); font-size: 13px; margin: 0 0 10px; }
.card { border-radius: 24px; padding: 16px 18px 6px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
/* a map case's diagram on a wide page: wider than the column, centred over it (the column is a flex column: it overflows evenly) */
.card.wide { align-self: center; max-width: none; flex: none; }
.card .flow, .card .steps { margin-bottom: 12px; }
.card.ctl { padding: 14px 16px; }
.ch { font-size: 13px; color: var(--text-secondary); margin: 0 0 12px 2px; display: flex; align-items: center; gap: 6px; }
.ch.row { justify-content: space-between; }
.seg { display: inline-flex; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 26px; padding: 0 12px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.diagram { margin: 0 -8px 12px; }
.ch.attn { color: var(--color-attention); font-weight: 500; }
.ch.out { margin: 8px 0 0 6px; }
.arts { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.file { display: inline-flex; align-items: center; gap: 10px; height: 56px; max-width: 100%; padding: 0 20px; border-radius: 20px; background: #1d1d1f; color: #f5f5f7; font-size: 15px; font-weight: 500; text-decoration: none; }
.file .fn { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file > :deep(svg) { flex: none; }
.doc { position: relative; width: 100%; border-radius: 24px; padding: 8px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); margin-bottom: 8px; }
.dh { display: flex; flex-direction: column; margin: 10px 12px 12px; }
.dh .serif { font-size: 20px; text-transform: capitalize; }
.dh small { color: var(--text-secondary); font-size: 12.5px; margin-top: 2px; }
.doc .inner { background: var(--field-bg); border-radius: 16px; padding: 12px 14px; font-size: 14px; line-height: 1.55; max-height: 140px; overflow: hidden;
  -webkit-mask-image: linear-gradient(#000 55%, transparent); mask-image: linear-gradient(#000 55%, transparent); transition: max-height .5s var(--spring); }
.doc.open .inner { max-height: 6000px; -webkit-mask-image: none; mask-image: none; overflow: auto; }
.md :deep(p) { margin: 0 0 .5em; } .md :deep(table) { border-collapse: collapse; font-size: 13px; display: block; overflow-x: auto; } .md :deep(td), .md :deep(th) { padding: 3px 6px; border-bottom: 1px solid var(--hairline); white-space: nowrap; }
.more { position: absolute; left: 50%; bottom: -14px; translate: -50% 0; width: 32px; height: 32px; border-radius: 9999px; display: grid; place-items: center; background: var(--regular-solid-bg); box-shadow: 0 2px 10px rgba(0 0 0 / .1); }
.more svg { transition: rotate .3s; }
.divider { text-align: center; font-size: 13px; color: var(--text-tertiary); padding-top: 16px; border-top: 1px solid var(--hairline); margin-top: 8px; }
.branch { border-radius: 20px; padding: 14px 16px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); font-size: 13.5px; }
.branch .bl { margin-top: 6px; } .branch .bs { color: var(--text-secondary); font-size: 12.5px; margin-top: 4px; }
.branch ul { margin: 8px 0 0; padding-left: 1.1em; } .branch code { font-size: 12px; }
.video { border-radius: 20px; padding: 14px 16px; background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); }
.video video { width: 100%; margin-top: 8px; border-radius: 12px; background: #000; aspect-ratio: 16 / 9; }
.imp { display: inline-block; margin-top: 8px; font-size: 13px; color: var(--text-secondary); }
.wf { display: flex; flex-direction: column; gap: 6px; padding: 0 6px; }
.wfl { display: flex; align-items: center; gap: 12px; min-width: 0; max-width: 100%; align-self: flex-start; padding: 10px 16px 10px 10px; border-radius: 18px;
  background: var(--bubble-agent-bg); box-shadow: var(--shadow-card); color: var(--text-primary); text-decoration: none; }
.wfi { flex: none; width: 34px; height: 34px; border-radius: 12px; display: grid; place-items: center; background: var(--field-bg); }
.wft { display: flex; flex-direction: column; min-width: 0; }
.wft b { font-size: 14px; font-weight: 600; }
.wft small { font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wfs { margin: 0 0 0 4px; display: flex; flex-wrap: wrap; gap: 4px; font-size: 12.5px; color: var(--text-secondary); }
.wfs a { color: var(--text-secondary); }
.wfs a:hover { color: var(--text-primary); }
.imp:hover { color: var(--text-primary); }
</style>
