<script setup>
import { computed } from 'vue'
import { useRouter, useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { whenText } from '../threadList.js'
import { topicPath, topicsShown } from '../projectTopics.js'

// projects only: a process instance is a 루틴 of its own (components/RoutineList.vue, /routines)
// The open project's sub-topics sit under it, a level down (2026-11-25: 「하나의 프로젝트 내에서도 서브 레벨로 주제들이 자동 분류」 —
// src/projectTopics.js): a row narrows the project's chat to that sub-topic; the project's own row is the whole project again.
const app = useApp()
const router = useRouter()
const route = useRoute()
const topics = computed(() => (topicsShown(app.topicList, app.topicFilter) ? app.topicList : []))
</script>

<template>
  <aside class="plist scroll">
    <button class="item new" :class="{ on: !route.params.id }" @click="router.push('/projects')">새 프로젝트</button>
    <TransitionGroup name="arc" tag="div" class="items">
      <div v-for="p in app.projects" :key="p.id" class="group">
        <button class="item" :class="{ on: app.activeId === p.id }" :data-project="p.id" @click="router.push(`/projects/${p.id}`)">
          {{ p.title }}
          <span v-if="p.status === 'needs_input'" class="badge attn"><Icon name="alert" :size="14" /> 입력 필요</span>
          <span v-else-if="p.status === 'working'" class="badge"><span class="spin" /> 작업 중</span>
        </button>
        <div v-if="app.activeId === p.id && topics.length" class="topics" data-testid="project-topics" aria-label="이 프로젝트의 주제">
          <button v-for="t in topics" :key="t.id" class="topic press" :class="{ on: app.topicFilter === t.id }" :aria-current="app.topicFilter === t.id ? 'true' : undefined"
            data-testid="project-topic" :data-conv="t.id" @click="router.push(topicPath(p.id, t.id))">
            <span class="tn">{{ t.title }}</span>
            <small class="tm">{{ whenText(t.updated_at) }} · {{ t.count }}</small>
          </button>
        </div>
      </div>
    </TransitionGroup>
  </aside>
</template>

<style scoped>
.plist { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: 420px; padding: 100px 40px 114px; }
.plist.mobile { width: auto; right: 0; padding: 88px 24px 112px; }
.plist.mobile .item { font-size: 22px; padding: 11px 0; }
.items { display: flex; flex-direction: column; }
.group { display: flex; flex-direction: column; }
.item { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left; font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; color: var(--text-secondary); padding: 14px 0; transition: color .3s; }
.item:hover { color: var(--text-primary); }
.item.on { color: var(--text-primary); font-weight: 500; }
.new { margin-bottom: 14px; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 9999px; font-size: 13px; font-weight: 500; letter-spacing: 0; background: var(--bubble-user-bg); color: var(--text-primary); }
.badge.attn { background: #e0613f; color: #fff; }
.spin { width: 12px; height: 12px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
/* a level down: the open project's sub-topics, indented under a thin line */
.topics { display: flex; flex-direction: column; gap: 2px; margin: -4px 0 10px 2px; padding-left: 14px; border-left: 2px solid var(--field-bg); }
.topic { display: flex; align-items: baseline; gap: 10px; min-width: 0; text-align: left; padding: 8px 12px; border-radius: 14px; color: var(--text-secondary); transition: color .3s, background-color .25s; }
.topic:hover { color: var(--text-primary); }
.topic.on { color: var(--text-primary); background: var(--field-bg); }
.tn { flex: 1; min-width: 0; font-size: 16px; line-height: 1.35; letter-spacing: -0.01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topic.on .tn { font-weight: 500; }
.tm { flex: none; font-size: 12px; color: var(--text-tertiary); }
</style>
