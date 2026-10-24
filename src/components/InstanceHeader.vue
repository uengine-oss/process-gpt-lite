<script setup>
import { ref, computed } from 'vue'
import { marked } from 'marked'
import StepTimeline from './StepTimeline.vue'
import AgentActivity from './AgentActivity.vue'
import { auth } from '../api.js'
import TodoCard from './TodoCard.vue'
import BpmnView from './BpmnView.vue'
import Icon from './Icon.vue'

// Top of an instance page: title, live flow, my pending inputs, and produced artifacts.
const props = defineProps({ data: Object })
const emit = defineEmits(['refresh'])
const openDoc = ref(null)
const view = ref('list')
const detail = ref(null)
// a <video> cannot send the bearer header, so the agent-file URL carries the token
const fileUrl = (a) => `/api/agent-files/${encodeURIComponent(a.runId)}?path=${encodeURIComponent(a.path)}&token=${encodeURIComponent(auth.get()?.session?.access_token || '')}`
const i = computed(() => props.data.inst)
const mine = computed(() => props.data.steps.filter((s) => s.mine && s.todoId))
const status = computed(() => ({ RUNNING: '진행 중', COMPLETED: '완료', NEW: '시작 전' }[i.value.status] || i.value.status))
const progress = computed(() => {
  const real = props.data.steps.filter((s) => s.kind === 'human' || s.kind === 'agent')
  return { done: real.filter((s) => s.state === 'done').length, all: real.length }
})
const md = (t) => marked.parse(String(t || '').replace(/</g, '&lt;'), { breaks: true })
const fieldLabel = (a) => a.label || a.field?.replace(/_/g, ' ')
const when = (d) => (d ? new Date(d).toLocaleString('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
</script>

<template>
  <div class="ih">
    <div class="title">
      <span class="pill" :class="i.status">{{ status }}</span>
      <h2 class="serif">{{ i.proc_inst_name || data.def?.name }}</h2>
      <p class="sub">{{ data.def?.name }} · {{ when(i.start_date) }} 시작 · {{ progress.done }}/{{ progress.all }} 단계</p>
      <div class="bar"><span :style="{ width: (progress.all ? progress.done / progress.all * 100 : 0) + '%' }" /></div>
    </div>

    <div class="card">
      <div class="ch row">진행 상황
        <span class="seg"><button :class="{ on: view === 'list' }" @click="view = 'list'">목록</button><button :class="{ on: view === 'bpmn' }" @click="view = 'bpmn'">다이어그램</button></span>
      </div>
      <StepTimeline v-if="view === 'list'" :steps="data.steps.filter((s) => s.kind !== 'event')" @detail="(s) => (detail = s)" />
      <BpmnView v-else class="diagram" :def-id="data.inst.proc_def_id" :steps="data.steps" :height="380" />
    </div>

    <div v-for="s in mine" :key="s.todoId" class="mine">
      <div class="ch attn"><Icon name="alert" :size="14" /> 내 입력이 필요해요</div>
      <TodoCard :todo-id="s.todoId" @submitted="emit('refresh')" />
    </div>

    <template v-if="data.artifacts.length">
      <div class="ch out">산출물 {{ data.artifacts.length }}</div>
      <div class="arts">
        <template v-for="(a, k) in data.artifacts" :key="k">
          <a v-if="a.kind === 'file'" :href="a.url" target="_blank" class="file press"><Icon name="doc" :size="18" /> {{ a.name }}</a>
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
.card { border-radius: 24px; padding: 16px 18px 6px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); }
.ch { font-size: 13px; color: var(--text-secondary); margin: 0 0 12px 2px; display: flex; align-items: center; gap: 6px; }
.ch.row { justify-content: space-between; }
.seg { display: inline-flex; padding: 2px; border-radius: 9999px; background: var(--field-bg); }
.seg button { height: 26px; padding: 0 12px; border-radius: 9999px; font-size: 12px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
.diagram { margin: 0 -8px 12px; }
.ch.attn { color: var(--color-attention); font-weight: 500; }
.ch.out { margin: 8px 0 0 6px; }
.arts { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
.file { display: inline-flex; align-items: center; gap: 10px; height: 56px; padding: 0 20px; border-radius: 20px; background: #1d1d1f; color: #f5f5f7; font-size: 15px; font-weight: 500; text-decoration: none; }
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
</style>
