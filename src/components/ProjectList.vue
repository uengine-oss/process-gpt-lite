<script setup>
import { useRouter, useRoute } from 'vue-router'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'

// projects only: a process instance is a 루틴 of its own (components/RoutineList.vue, /routines)
const app = useApp()
const router = useRouter()
const route = useRoute()
</script>

<template>
  <aside class="plist scroll">
    <button class="item new" :class="{ on: !route.params.id }" @click="router.push('/projects')">새 프로젝트</button>
    <TransitionGroup name="arc" tag="div" class="items">
      <button v-for="p in app.projects" :key="p.id" class="item" :class="{ on: app.activeId === p.id }" @click="router.push(`/projects/${p.id}`)">
        {{ p.title }}
        <span v-if="p.status === 'needs_input'" class="badge attn"><Icon name="alert" :size="14" /> 입력 필요</span>
        <span v-else-if="p.status === 'working'" class="badge"><span class="spin" /> 작업 중</span>
      </button>
    </TransitionGroup>
  </aside>
</template>

<style scoped>
.plist { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: 420px; padding: 100px 40px 114px; }
.plist.mobile { width: auto; right: 0; padding: 88px 24px 112px; }
.plist.mobile .item { font-size: 22px; padding: 11px 0; }
.items { display: flex; flex-direction: column; }
.item { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left; font-size: 26px; line-height: 1.3; letter-spacing: -0.02em; color: var(--text-secondary); padding: 14px 0; transition: color .3s; }
.item:hover { color: var(--text-primary); }
.item.on { color: var(--text-primary); font-weight: 500; }
.new { margin-bottom: 14px; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: 9999px; font-size: 13px; font-weight: 500; letter-spacing: 0; background: var(--bubble-user-bg); color: var(--text-primary); }
.badge.attn { background: #e0613f; color: #fff; }
.spin { width: 12px; height: 12px; border-radius: 9999px; border: 2px solid currentColor; border-right-color: transparent; animation: spin .8s linear infinite; }
</style>
