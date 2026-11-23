<script setup>
// 말로 고치기의 계획(server Plan)을 글로만: 바뀌는 것(더함 · 뺌 · 바뀜) · 회사에 이미 있는 일로 맞춘 이름 · 하지 않은 것과 까닭 ·
// 되묻는 것. 그림은 쓰는 쪽이 따로 그린다 — 채팅 카드(OntoEditCard · ProcessDraftCard) · 건 지켜보기(OntoCaseRun) · 지도의 고치기 상자.
import { computed } from 'vue'

const props = defineProps({ plan: { type: Object, default: null } })
const MARK = { add: '더함', remove: '뺌', change: '바뀜' }
const p = computed(() => props.plan || {})
const changes = computed(() => p.value.changes || [])
const matched = computed(() => p.value.matched || [])
const refused = computed(() => p.value.refused || [])
</script>

<template>
  <div class="ocl" data-testid="onto-change-list" :data-changes="changes.length" :data-refused="refused.length">
    <ul v-if="changes.length" class="ch">
      <li v-for="(x, i) in changes" :key="i" :class="x.kind" data-testid="onto-change-item" :data-kind="x.kind"><span class="mk">{{ MARK[x.kind] || x.kind }}</span><span class="tx">{{ x.text }}</span></li>
    </ul>
    <p v-else-if="!p.question" class="none" data-testid="onto-change-none">지도에서 바뀌는 것이 없어요.</p>
    <ul v-if="matched.length" class="mt">
      <li v-for="(m, i) in matched" :key="i" data-testid="onto-change-matched">{{ m.said }} → 이미 있는 일 「{{ m.task }}」</li>
    </ul>
    <div v-if="refused.length" class="rf">
      <small class="cap">하지 않은 것</small>
      <ul>
        <li v-for="(r, i) in refused" :key="i" data-testid="onto-change-refused">{{ r.label }}<small v-if="r.why"> — {{ r.why }}</small></li>
      </ul>
    </div>
    <p v-if="p.note" class="note">{{ p.note }}</p>
    <p v-if="p.question" class="qn" data-testid="onto-change-question"><small class="cap">물어볼 것</small>{{ p.question }}</p>
  </div>
</template>

<style scoped>
.ocl { display: flex; flex-direction: column; gap: 6px; min-width: 0; word-break: keep-all; overflow-wrap: anywhere; }
ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.ch li { display: flex; align-items: baseline; gap: 8px; font-size: 13.5px; line-height: 1.5; }
.mk { flex: none; font-size: 11px; font-weight: 600; padding: 0 7px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); white-space: nowrap; }
.ch .add .mk { background: color-mix(in srgb, var(--color-info) 20%, transparent); color: var(--text-primary); }
.ch .remove .mk { background: color-mix(in srgb, var(--color-error) 16%, transparent); color: var(--text-primary); }
.ch .change .mk { background: color-mix(in srgb, #d9822b 22%, transparent); color: var(--text-primary); }
.tx { min-width: 0; }
.none { margin: 0; font-size: 13px; color: var(--text-secondary); }
.mt li { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.rf { display: flex; flex-direction: column; gap: 3px; }
.rf li { font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.rf li small { color: var(--text-tertiary); }
.cap { display: block; font-size: 11.5px; color: var(--text-tertiary); }
.note { margin: 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.5; }
.qn { margin: 0; padding: 8px 10px; border-radius: 12px; background: var(--field-bg); font-size: 13.5px; line-height: 1.5; }
</style>
