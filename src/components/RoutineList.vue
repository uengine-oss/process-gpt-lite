<script setup>
import { ref, computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'

// 루틴: the process instances I am part of (2026-11-18: "프로세스 인스턴스는 프로젝트가 아니다" — they left
// ProjectList). Waiting on me first, then the ones underway, then the recently finished, folded.
const app = useApp()
const router = useRouter()
const route = useRoute()
const showDone = ref(false)
const FOLDED = 5
const ended = computed(() => app.instances.filter((i) => i.status === 'COMPLETED'))
const groups = computed(() => {
  const open = app.instances.filter((i) => i.status !== 'COMPLETED')
  return [
    { id: 'mine', label: '내 입력이 필요해요', items: open.filter((i) => i.needs_me) },
    // a failed agent step is the one to look at among those underway
    { id: 'open', label: '진행 중', items: open.filter((i) => !i.needs_me).sort((a, b) => b.agent_failed - a.agent_failed) },
    { id: 'done', label: '완료됨', items: showDone.value ? ended.value : ended.value.slice(0, FOLDED) },
  ].filter((g) => g.items.length)
})
const hiddenDone = computed(() => Math.max(0, ended.value.length - FOLDED))
const go = (i) => router.push(`/routines/${encodeURIComponent(i.proc_inst_id)}`)
</script>

<template>
  <aside class="rlist scroll">
    <div class="head">
      <span class="title">루틴</span>
      <router-link class="imp" to="/improve">개선 분석 →</router-link>
    </div>
    <p v-if="!app.instances.length" class="empty">아직 루틴이 없어요. 채팅에서 등록된 프로세스를 시작하면 여기에 모여요.</p>
    <section v-for="g in groups" :key="g.id">
      <div class="sec" :class="{ attn: g.id === 'mine' }"><Icon v-if="g.id === 'mine'" name="alert" :size="13" /> {{ g.label }}</div>
      <TransitionGroup name="arc" tag="div" class="items">
        <button v-for="i in g.items" :key="i.proc_inst_id" class="item" :class="{ on: route.params.instId === i.proc_inst_id, ended: i.status === 'COMPLETED' }" @click="go(i)">
          <span class="name">{{ i.proc_inst_name || i.def_name }}</span>
          <!-- which process it is, when its name does not already say so -->
          <small v-if="i.def_name && i.proc_inst_name && !i.proc_inst_name.includes(i.def_name)" class="def">{{ i.def_name }}</small>
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
.head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 6px; }
.title { font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; font-weight: 500; color: var(--text-primary); }
.imp { font-size: 14px; color: var(--text-secondary); white-space: nowrap; }
.imp:hover { color: var(--text-primary); }
.empty { margin-top: 18px; font-size: 15px; line-height: 1.5; color: var(--text-secondary); }
.sec { display: flex; align-items: center; gap: 5px; font-size: 13px; color: var(--text-tertiary); margin: 26px 0 2px; letter-spacing: .04em; }
.sec.attn { color: #e0613f; }
.items { display: flex; flex-direction: column; }
.item { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; text-align: left; font-size: 20px; line-height: 1.3; letter-spacing: -0.02em; color: var(--text-secondary); padding: 12px 0; transition: color .3s; }
.rlist.mobile .item { font-size: 19px; padding: 11px 0; }
.item:hover { color: var(--text-primary); }
.item.on { color: var(--text-primary); font-weight: 500; }
.item.ended, .rlist.mobile .item.ended { opacity: .6; font-size: 17px; }
.def { font-size: 13px; letter-spacing: 0; color: var(--text-tertiary); font-weight: 400; }
.more { font-size: 14px; color: var(--text-secondary); padding: 10px 0; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 9999px; font-size: 13px; font-weight: 500; letter-spacing: 0; background: var(--bubble-user-bg); color: var(--text-primary); }
.badge.attn { background: #e0613f; color: #fff; }
.badge.failed { background: var(--color-error); color: #fff; }
.badge.still { color: var(--text-secondary); }
.spin { width: 12px; height: 12px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
</style>
