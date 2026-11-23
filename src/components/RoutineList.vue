<script setup>
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'

// 루틴: the process instances I am part of (2026-11-18: "프로세스 인스턴스는 프로젝트가 아니다" — they left
// ProjectList). Waiting on me first, then the ones underway, then the recently finished, folded.
// Two kinds side by side (2026-11-19): Lite's — a case of the company's process map (run straight from the map, or as its
// BPMN snapshot), seen in its case view on the map — and classic ones, from a process definition made in Process GPT 본판
// (people who came over from it), on their instance page. The classic 개선 분석 opens only from here (「클래식 개선 분석」);
// Lite's processes are seen and improved on the map.
const app = useApp()
const router = useRouter()
const route = useRoute()
const showDone = ref(false)
const FOLDED = 5
const isLite = (i) => !!i.case_id
const mapOn = computed(() => app.me?.ontology !== false)
const kinds = computed(() => ({ lite: app.instances.filter(isLite).length, classic: app.instances.filter((i) => !isLite(i)).length }))
// the filter shows only when both kinds are there
const kind = ref('all')
const shown = computed(() => (kind.value === 'all' ? app.instances : app.instances.filter((i) => isLite(i) === (kind.value === 'lite'))))
const ended = computed(() => shown.value.filter((i) => i.status === 'COMPLETED'))
const groups = computed(() => {
  const open = shown.value.filter((i) => i.status !== 'COMPLETED')
  return [
    { id: 'mine', label: '내 입력이 필요해요', items: open.filter((i) => i.needs_me) },
    // a failed agent step is the one to look at among those underway
    { id: 'open', label: '진행 중', items: open.filter((i) => !i.needs_me).sort((a, b) => b.agent_failed - a.agent_failed) },
    { id: 'done', label: '완료됨', items: showDone.value ? ended.value : ended.value.slice(0, FOLDED) },
  ].filter((g) => g.items.length)
})
const hiddenDone = computed(() => Math.max(0, ended.value.length - FOLDED))
// a Lite case opens its case view on the map (server lib/ontology/mapengine.js · run.js); a classic one its instance page
const go = (i) => (isLite(i)
  ? router.push(`/process-map?proc=${encodeURIComponent(i.case_proc || '')}&case=${encodeURIComponent(i.case_id)}`)
  : router.push(`/routines/${encodeURIComponent(i.proc_inst_id)}`))
</script>

<template>
  <aside class="rlist scroll" data-testid="routine-list">
    <div class="head">
      <span class="title">루틴</span>
      <router-link v-if="mapOn" class="imp" to="/process-map" data-testid="routine-map-link">프로세스 지도 →</router-link>
      <router-link class="imp sub" :to="{ path: '/improve', query: { classic: '1' } }" data-testid="routine-classic-improve">{{ mapOn ? '클래식 개선 분석' : '개선 분석 →' }}</router-link>
    </div>
    <div v-if="kinds.lite && kinds.classic" class="kinds" role="group" aria-label="루틴 종류" data-testid="routine-kinds">
      <button class="press" :class="{ on: kind === 'all' }" data-kind="all" @click="kind = 'all'">모두 <small>{{ kinds.lite + kinds.classic }}</small></button>
      <button class="press" :class="{ on: kind === 'lite' }" data-kind="lite" @click="kind = 'lite'">Lite <small>{{ kinds.lite }}</small></button>
      <button class="press" :class="{ on: kind === 'classic' }" data-kind="classic" @click="kind = 'classic'">클래식 <small>{{ kinds.classic }}</small></button>
    </div>
    <p v-if="!app.instances.length" class="empty">아직 루틴이 없어요. 채팅에서 등록된 프로세스를 시작하거나 프로세스 지도에서 건을 시작하면 여기에 모여요.</p>
    <section v-for="g in groups" :key="g.id">
      <div class="sec" :class="{ attn: g.id === 'mine' }"><Icon v-if="g.id === 'mine'" name="alert" :size="13" /> {{ g.label }}</div>
      <TransitionGroup name="arc" tag="div" class="items">
        <button v-for="i in g.items" :key="i.proc_inst_id" class="item" :class="{ on: route.params.instId === i.proc_inst_id, ended: i.status === 'COMPLETED' }"
          :data-testid="isLite(i) ? 'instance-map-case' : 'instance-item'" :data-inst="i.proc_inst_id" :data-kind="isLite(i) ? 'lite' : 'classic'" @click="go(i)">
          <span class="name">{{ i.proc_inst_name || i.def_name }}</span>
          <span class="by">
            <span class="tag" :class="isLite(i) ? 'lite' : 'classic'" data-testid="instance-kind">{{ isLite(i) ? 'Lite' : '클래식' }}</span>
            <!-- which process it is, when its name does not already say so; who started a Lite case -->
            <template v-if="i.def_name && i.proc_inst_name && !i.proc_inst_name.includes(i.def_name)"> {{ i.def_name }}</template>
            <template v-if="isLite(i) && i.starter_name"> · {{ i.starter_name }} 시작</template>
          </span>
          <!-- (waiting on me: the group's heading says so) the spinner is for an agent actually at work; a
               step waiting on a person (HITL) or a long-running process at rest gets a still badge -->
          <template v-if="g.id === 'open'">
            <span v-if="i.status === 'RUNNING' && i.agent_failed" class="badge failed"><Icon name="alert" :size="14" /> 에이전트 단계 실패</span>
            <span v-else-if="i.status === 'RUNNING' && i.agent_running" class="badge"><span class="spin" /> 에이전트 작업 중</span>
            <span v-else-if="i.status === 'RUNNING' && i.human_waiting" class="badge still"><Icon name="hand" :size="13" /> 담당자 확인 대기</span>
          </template>
        </button>
      </TransitionGroup>
      <button v-if="g.id === 'done' && hiddenDone && !showDone" class="more" @click="showDone = true">완료된 루틴 {{ hiddenDone }}개 더 보기</button>
    </section>
  </aside>
</template>

<style scoped>
.rlist { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: 420px; padding: 100px 40px 60px; }
.rlist.mobile { width: auto; right: 0; padding: 88px 24px 48px; }
.head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; margin-bottom: 6px; }
.title { font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; font-weight: 500; color: var(--text-primary); }
.imp { font-size: 14px; color: var(--text-secondary); white-space: nowrap; }
.imp.sub { font-size: 13px; color: var(--text-tertiary); }
.imp:hover { color: var(--text-primary); }
.kinds { display: inline-flex; gap: 2px; padding: 2px; margin-top: 14px; border-radius: 9999px; background: var(--field-bg); }
.kinds button { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 13px; color: var(--text-secondary); }
.kinds button small { font-size: 12px; color: var(--text-tertiary); margin-left: 2px; }
.kinds button.on { background: var(--ink); color: var(--text-primary-on); }
.kinds button.on small { color: inherit; opacity: .7; }
.empty { margin-top: 18px; font-size: 15px; line-height: 1.5; color: var(--text-secondary); }
.sec { display: flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-tertiary); margin: 26px 0 2px; letter-spacing: .04em; }
.sec.attn { color: #e0613f; }
.items { display: flex; flex-direction: column; }
.item { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; font-size: 20px; line-height: 1.3; letter-spacing: -0.02em; color: var(--text-secondary); padding: 12px 0; transition: color .3s; }
.rlist.mobile .item { font-size: 19px; padding: 11px 0; }
.item:hover { color: var(--text-primary); }
.item.on { color: var(--text-primary); font-weight: 500; }
.item.ended, .rlist.mobile .item.ended { opacity: .6; font-size: 17px; }
.by { font-size: 13px; letter-spacing: 0; color: var(--text-tertiary); font-weight: 400; }
.by .tag { display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border-radius: 9999px; font-size: 11px; font-weight: 500; }
.by .tag.lite { background: color-mix(in srgb, var(--color-info) 16%, transparent); color: var(--text-primary); }
.by .tag.classic { background: var(--field-bg); color: var(--text-secondary); }
.more { font-size: 14px; color: var(--text-secondary); padding: 10px 0; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 9999px; font-size: 13px; font-weight: 500; letter-spacing: 0; background: var(--bubble-user-bg); color: var(--text-primary); }
.badge.attn { background: #e0613f; color: #fff; }
.badge.failed { background: var(--color-error); color: #fff; }
.badge.still { color: var(--text-secondary); }
.spin { width: 12px; height: 12px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
</style>
