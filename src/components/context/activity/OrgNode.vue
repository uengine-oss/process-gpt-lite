<script setup>
// 조직도 노드 하나(GET /team-activity/org): 사람·맥락(비공개는 건수만)·턴·진행 중인 AI 작업·비용, 작업 유형, 주요 주제. 아래 노드는 펼쳐서 본다.
import { ref, computed } from 'vue'
import { DEPTH, kindColor, credits } from './fmt.js'

defineOptions({ name: 'OrgNode' })
const props = defineProps({ node: Object, level: { type: Number, default: 0 } })
const emit = defineEmits(['open'])
const openKids = ref(props.level < 2)
const s = computed(() => props.node.stats)
const total = computed(() => s.value.kinds.reduce((n, k) => n + k.count, 0) || 1)
// 아래 노드가 있는 노드(회사·본부)는 주제를 칩 세 개로만 — 한 줄 요약은 팀 노드에서
const leaf = computed(() => !props.node.children.length)
const go = (t) => emit('open', { user: t.owner, conversationId: t.conversationId, title: t.title })
</script>

<template>
  <div class="on">
    <div class="nd glass" :class="`l${level}`">
      <header>
        <b>{{ node.name }}</b>
        <small v-if="node.lead">장 {{ node.lead.name }}</small>
        <small v-if="node.members.length" class="mem">{{ node.members.map((m) => m.name).join(' · ') }}</small>
        <span class="sp" />
        <button v-if="node.children.length" class="tog press" @click="openKids = !openKids">{{ openKids ? '접기' : `아래 ${node.children.length}개 펼치기` }}</button>
      </header>
      <div class="st">
        <span>사람 <b>{{ s.people }}</b></span>
        <span>맥락 <b>{{ s.contexts }}</b><small v-if="s.private"> (비공개 {{ s.private }})</small></span>
        <span>턴 <b>{{ s.turns }}</b></span>
        <span>진행 중 AI <b>{{ s.running }}</b></span>
        <span>비용 <b>{{ credits(s.cost) }}</b></span>
      </div>
      <div v-if="s.kinds.length" class="bar"><i v-for="k in s.kinds" :key="k.name" :style="{ flex: k.count, background: kindColor(k.name) }" :title="`${k.name} ${k.count}`" /></div>
      <div v-if="s.kinds.length" class="legend"><span v-for="k in s.kinds.slice(0, 5)" :key="k.name"><i :style="{ background: kindColor(k.name) }" />{{ k.name }} {{ Math.round(k.count / total * 100) }}%</span></div>
      <div v-if="s.topics.length && !leaf" class="chips">
        <span class="lb">주요 주제</span>
        <button v-for="t in s.topics.slice(0, 3)" :key="t.conversationId" class="chip press" @click="go(t)">{{ t.title }} <small>{{ t.owner_name }}</small></button>
      </div>
      <ul v-else-if="s.topics.length" class="tp">
        <li v-for="t in s.topics" :key="t.conversationId" class="press" @click="go(t)">
          <span class="h"><b>{{ t.title }}</b><small>{{ t.owner_name }} · {{ t.turns }}턴</small><i class="dp" :class="t.depth">{{ DEPTH[t.depth] }}</i></span>
          <span v-if="t.line" class="ln">{{ t.line }}</span>
        </li>
      </ul>
      <p v-else class="none">최근 30일 동안 보이는 주제가 없어요</p>
    </div>
    <div v-if="node.children.length && openKids" class="kids">
      <OrgNode v-for="c in node.children" :key="c.id" :node="c" :level="level + 1" @open="emit('open', $event)" />
    </div>
  </div>
</template>

<style scoped>
.on { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.nd { border-radius: 18px; padding: 12px 14px; display: flex; flex-direction: column; gap: 7px; }
.nd.l0 { border-top: 3px solid var(--ink); }
header { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
header b { font-size: 16px; font-weight: 600; }
header small { color: var(--text-secondary); font-size: 12.5px; }
header .mem { color: var(--text-tertiary); }
.sp { flex: 1; }
.tog { font-size: 12.5px; padding: 3px 10px; border-radius: 10px; background: var(--button-bg); color: var(--text-secondary); }
.st { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--text-secondary); }
.st b { color: var(--text-primary); font-weight: 600; }
.st small { color: var(--text-tertiary); }
.bar { display: flex; height: 7px; border-radius: 4px; overflow: hidden; gap: 2px; }
.bar i { display: block; height: 100%; }
.legend { display: flex; flex-wrap: wrap; gap: 3px 10px; font-size: 12px; color: var(--text-secondary); }
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; }
.tp { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.tp li { padding: 6px 9px; border-radius: 11px; background: var(--cell-bg); cursor: pointer; display: flex; flex-direction: column; gap: 1px; }
.tp li:hover { background: var(--button-bg); }
.h { display: flex; align-items: center; gap: 6px; min-width: 0; }
.h b { font-weight: 500; font-size: 13.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.h small { color: var(--text-tertiary); font-size: 12px; flex: none; }
.dp { margin-left: auto; font-style: normal; font-size: 11px; padding: 1px 7px; border-radius: 8px; background: var(--field-bg); color: var(--text-secondary); flex: none; }
.dp.summary { background: rgba(76, 141, 246, .16); color: var(--color-info); }
.dp.content { background: rgba(59, 185, 138, .16); color: var(--color-success); }
.ln { font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.none { margin: 0; font-size: 12.5px; color: var(--text-tertiary); }
.chips { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; }
.chips .lb { font-size: 12px; color: var(--text-secondary); margin-right: 2px; }
.chip { font-size: 12.5px; padding: 3px 10px; border-radius: 10px; background: var(--cell-bg); }
.chip:hover { background: var(--button-bg); }
.chip small { color: var(--text-tertiary); margin-left: 3px; }
.kids { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 10px; padding-left: 14px; border-left: 2px solid var(--hairline); margin-left: 6px; }
</style>
