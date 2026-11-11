<script setup>
// One step of a recommendation's flow (MiningView "찾은 흐름"): who did it, with which tools and skills, in how
// many cases — and what the process definition (BPMN) says of it: 필수, 옵션 (a branch goes on without it) or
// 택일 (one branch of an exclusive gateway, done instead of the other branch's step). Admin-confirmed: lock;
// decided by the work (the cases' requests sorted every case the way it went): check.
import Icon from '../Icon.vue'

const props = defineProps({ x: Object, no: Number, total: Number, i: { type: Number, default: 0 }, pending: Boolean })
const kindText = { required: '필수', optional: '옵션', choice: '택일', absent: '정의에 없음' }
// (the tools a step used, as recorded — lib/mining/catalog.js)
const toolIcon = { 메일: '✉', 캐드크래프트: '◫', 아래아한글: '한', 엑셀: '▦', '팀 공유': '⇄', Mail: '✉', CADCraft: '◫', Word: 'W', Excel: '▦', 'Team share': '⇄' }
const tip = (d) => {
  if (!d) return ''
  const how = d.kind === 'choice'
    ? `택일 — ${(d.alternatives || []).map((a) => `'${a}'`).join('·')} 대신${d.when ? ` · ${d.when}` : ''}`
    : `${kindText[d.kind]}${d.skip_when ? ` — ${d.skip_when} 건너뜀` : ''}`
  return `${how} · 사례 ${d.cases}/${d.total}건이 거침${d.by === 'admin' ? ' · 관리자 확정' : d.by === 'cases' ? ` · 업무 흐름 ${d.sorted}건 맞음` : ''}`
}
</script>

<template>
  <div class="step glass" :class="{ pending }" :style="{ '--i': i }">
    <div class="top"><span class="no">{{ no }}</span><span class="kind" :class="x.kind">{{ x.kind === 'agent' ? '에이전트' : '사람' }}</span><span class="freq">{{ x.cases }}/{{ total }}건</span><i v-if="pending" class="pdot" title="확인 필요" /></div>
    <span v-if="x.decided" class="req" :class="[x.decided.kind, x.decided.by]" :title="tip(x.decided)"><Icon v-if="x.decided.by === 'admin'" name="lock" :size="11" /><Icon v-else-if="x.decided.by === 'cases'" name="check" :size="11" />{{ kindText[x.decided.kind] }}</span>
    <b class="nm">{{ x.activity }}</b>
    <span class="role">{{ x.role || x.performers?.[0] }}</span>
    <div class="tools">
      <span v-for="t in x.tools" :key="t" class="tool"><i>{{ toolIcon[t] || '•' }}</i>{{ t }}</span>
    </div>
    <div class="skills"><code v-for="k in x.skills" :key="k">{{ k }}</code></div>
    <small v-if="x.performers?.length" class="who">{{ x.performers.join(', ') }}</small>
  </div>
</template>

<style scoped>
.step { border-radius: 20px; padding: 12px; display: flex; flex-direction: column; gap: 5px; min-width: 0; height: 100%; box-sizing: border-box; animation: blur-in .45s var(--spring) both; animation-delay: calc(var(--i) * 70ms); }
.top { display: flex; align-items: center; gap: 6px; }
/* 확인 필요: 관리자가 아직 정하지 않은 분기 */
.step.pending { box-shadow: inset 0 0 0 1.5px var(--color-attention); }
.pdot { width: 7px; height: 7px; border-radius: 4px; background: var(--color-attention); flex: none; }
.no { width: 20px; height: 20px; border-radius: 10px; background: var(--chip-bg); display: grid; place-items: center; font-size: 11.5px; flex: none; }
.kind { font-size: 11.5px; padding: 1px 7px; border-radius: 8px; background: var(--chip-bg); color: var(--text-secondary); white-space: nowrap; }
.kind.agent { background: rgba(161 208 255 / .2); color: var(--color-info); }
.freq { margin-left: auto; font-size: 11.5px; color: var(--text-secondary); white-space: nowrap; }
.nm { font-size: 15.5px; font-weight: 600; line-height: 1.3; }
.role { font-size: 13px; color: var(--text-secondary); }
.tools, .skills { display: flex; flex-wrap: wrap; gap: 4px; }
.tool { font-size: 12px; padding: 2px 8px 2px 4px; border-radius: 10px; background: var(--field-bg); display: inline-flex; align-items: center; gap: 4px; }
.tool i { font-style: normal; width: 16px; height: 16px; border-radius: 5px; background: var(--chip-bg); display: inline-grid; place-items: center; font-size: 10px; }
code { font-size: 11.5px; padding: 1px 6px; border-radius: 6px; background: rgba(150 240 176 / .14); color: var(--color-success); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere; }
.who { font-size: 11.5px; color: var(--text-tertiary); }
/* 필수·옵션·택일: 관리자 확정은 채운 배지(자물쇠), 정의를 읽은 값은 점선. 택일은 갈래 색 */
.req { display: inline-flex; align-items: center; gap: 3px; width: fit-content; font-size: 11.5px; padding: 1px 8px; border-radius: 9px; border: 1px dashed var(--hairline); color: var(--text-secondary); }
.req.required { color: var(--text-primary); }
.req.choice { border-style: solid; border-color: rgba(161 208 255 / .45); color: var(--color-info); }
.req.admin, .req.cases { border-style: solid; background: var(--chip-bg); }
</style>
