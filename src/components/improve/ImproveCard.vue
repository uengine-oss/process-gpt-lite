<script setup>
// 채팅의 프로세스 개선 카드: 비서가 설명한 숫자(결정적 계산 결과)와 개선 화면으로 가는 길 (lib/agent.js improveTurn)
import { useRouter } from 'vue-router'
defineProps({ c: Object })
const router = useRouter()
</script>

<template>
  <button class="icard glass press" @click="router.push(c.url + '?tab=constraint')">
    <span class="ih">프로세스 개선 · {{ c.name }} <small>완료 {{ c.completed }}건 기준</small></span>
    <div class="nums">
      <span>리드타임 중앙값 <b>{{ c.lead?.median }}</b></span>
      <span>흐름 효율 <b>{{ c.flow }}</b></span>
      <span v-if="c.constraint" class="cst">제약 <b>{{ c.constraint.step }}</b> · {{ c.constraint.who }} 가동률 {{ c.constraint.utilization }}</span>
    </div>
    <small class="path">크리티컬 패스 {{ (c.path || []).join(' → ') }}</small>
    <ul v-if="c.actions?.length">
      <li v-for="a in c.actions" :key="a.title">{{ a.title }} <b>{{ a.lead }}</b></li>
    </ul>
    <span class="go">개선 화면에서 바꿔 보기 →</span>
  </button>
</template>

<style scoped>
.icard { display: flex; flex-direction: column; gap: 6px; text-align: left; padding: 14px 18px; border-radius: 20px; max-width: 560px; }
.ih { font-size: 13px; color: var(--text-secondary); }
.ih small { color: var(--text-tertiary); margin-left: 6px; }
.nums { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 13.5px; color: var(--text-secondary); }
.nums b { color: var(--text-primary); font-size: 16px; }
.cst b { color: #e0613f; }
.path { font-size: 12.5px; color: #e0613f; }
ul { margin: 2px 0 0; padding-left: 18px; font-size: 13.5px; line-height: 1.55; }
li b { font-variant-numeric: tabular-nums; }
.go { font-size: 13px; font-weight: 500; margin-top: 2px; }
</style>
