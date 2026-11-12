<script setup>
// 「지난 메일 읽기」가 끝나고 지도가 그려지면 오는 카드(server lib/ontology/service.js postSummary):
// 찾은 일 · 흐름 수, 흐름(프로세스)마다 띠와 건수, 그리고 「프로세스 지도 보기」.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { SOURCE_KO } from './fmt.js'

const props = defineProps({ msg: Object })
const router = useRouter()
const c = computed(() => props.msg.content || {})
const processes = computed(() => [...(c.value.processes || [])].sort((a, b) => (b.cases || 0) - (a.cases || 0)))
const sources = computed(() => Object.entries(c.value.sources || {}).filter(([, n]) => n > 0).map(([k, n]) => `${SOURCE_KO[k] || k} ${n.toLocaleString('ko-KR')}`))
const BAND_KO = { paved: '굳은 길', open: '열린 일', watch: '지켜보기' }
const go = (key) => router.push(key ? `${c.value.url || '/process-map'}?proc=${encodeURIComponent(key)}` : c.value.url || '/process-map')
</script>

<template>
  <div class="os" data-testid="onto-summary-card">
    <span class="badge">회사 프로세스 지도</span>
    <p class="txt">{{ c.text }}</p>
    <div v-if="processes.length" class="bl">
      <button v-for="b in processes" :key="b.key" class="b press" :class="b.band" data-testid="onto-summary-proc" @click="go(b.key)">
        <span class="bn">{{ b.name }}</span>
        <span class="band">{{ b.bandName || BAND_KO[b.band] || b.band }}</span>
        <span class="n">건 {{ b.cases ?? 0 }}</span>
      </button>
    </div>
    <small v-if="sources.length" class="src">읽은 것 · {{ sources.join(' · ') }}</small>
    <button class="go press" data-testid="onto-summary-open" @click="go()">프로세스 지도 보기</button>
  </div>
</template>

<style scoped>
.os { word-break: keep-all; overflow-wrap: anywhere; width: 424px; max-width: 100%; display: flex; flex-direction: column; gap: 10px; padding: 16px 16px 14px; border-radius: 24px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
.txt { margin: 0; font-size: 15.5px; line-height: 1.6; word-break: keep-all; overflow-wrap: anywhere; }
.bl { display: flex; flex-direction: column; gap: 6px; }
.b { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 6px 8px 6px 14px; border-radius: 14px; background: var(--field-bg); text-align: left; min-width: 0; }
.bn { flex: 1; min-width: 0; font-size: 14.5px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.band { flex: none; font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 9999px; background: var(--chip-bg); color: var(--text-secondary); }
.paved .band { background: color-mix(in srgb, var(--color-success) 20%, transparent); color: var(--color-success); }
.open .band { background: color-mix(in srgb, var(--color-info) 20%, transparent); color: var(--color-info); }
.watch .band { background: rgba(232, 145, 58, .2); color: #ffb36b; }
:root[data-theme="light"] .watch .band { color: #b35c00; }
.n { flex: none; min-width: 52px; text-align: right; font-size: 12.5px; color: var(--text-secondary); font-variant-numeric: tabular-nums; }
.src { font-size: 12px; color: var(--text-tertiary); }
.go { align-self: flex-start; height: 40px; padding: 0 18px; border-radius: 9999px; background: var(--ink); color: var(--ink-inverse); font-size: 14.5px; font-weight: 600; margin-top: 2px; }
</style>
