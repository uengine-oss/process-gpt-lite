<script setup>
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import SkillSheet from './SkillSheet.vue'
import { servicesOf } from './skillMeta.js'
import { api } from '../api.js'

// 스킬: the tenant skills deepagents (and cli-agent) run, each with a short summary, the
// scheduled tasks that use it, and ways to schedule it or remove it.
const props = defineProps({ name: String })
const router = useRouter()
const items = ref([])
const skill = ref(null)
const err = ref('')
const sheet = ref(false)
const presets = [
  { label: '매일 아침 8시', cron: '0 8 * * *' },
  { label: '하루 두 번(12·21시)', cron: '0 12,21 * * *' },
  { label: '평일 장중 매시', cron: '0 9-15 * * 1-5' },
  { label: '매주 월 9시', cron: '0 9 * * 1' },
]
const pick = ref(null)
const params = ref('')
const busy = ref(false)

async function load() {
  err.value = ''
  skill.value = null
  if (props.name) {
    try { skill.value = await api(`/skills/${encodeURIComponent(props.name)}`) } catch (e) { err.value = '스킬을 불러오지 못했어요. ' + e.message.slice(0, 100) }
  } else {
    items.value = await api('/skills')
  }
}
watch(() => props.name, load, { immediate: true })

async function schedule() {
  let p = {}
  try { p = params.value.trim() ? JSON.parse(params.value) : {} } catch { err.value = '입력값은 JSON 형식이어야 해요.'; return }
  busy.value = true
  try {
    await api(`/skills/${encodeURIComponent(props.name)}/missions`, { method: 'POST', body: { cron: pick.value.cron, params: p } })
    pick.value = null
    params.value = ''
    await load()
  } finally { busy.value = false }
}
async function remove() {
  if (!confirm(`${props.name} 스킬을 삭제할까요? 이 스킬을 쓰는 예약 작업은 실패하게 됩니다.`)) return
  await api(`/skills/${encodeURIComponent(props.name)}`, { method: 'DELETE' })
  router.push('/settings/skills')
}
</script>

<template>
  <div v-if="!name">
    <p class="cap">테넌트 스킬 {{ items.length }}개 · 채팅에서 "○○ 스킬 만들어줘"로 추가돼요.</p>
    <div class="list glass">
      <button v-for="s in items" :key="s.name" class="li" @click="router.push(`/settings/skills/${encodeURIComponent(s.name)}`)">
        <div class="main">
          <b>{{ s.name }}<span v-if="s.missions?.length" class="tag">예약 {{ s.missions.length }}</span></b>
          <small>{{ s.description }}</small>
        </div>
        <Icon name="chevron" :size="16" />
      </button>
    </div>
  </div>

  <div v-else class="detail">
    <p v-if="err" class="err">{{ err }}</p>
    <template v-if="skill">
      <h2 class="serif">{{ skill.name }}</h2>
      <p class="desc">{{ skill.description }}</p>
      <div class="meta">
        <span v-for="s in servicesOf(skill.tools)" :key="s" class="svc">{{ s }}</span>
        <span v-if="skill.stepCount" class="count">절차 {{ skill.stepCount }}단계</span>
      </div>

      <div class="list glass">
        <div v-if="skill.steps?.length" class="block">
          <p class="lab">절차</p>
          <ol class="steps"><li v-for="(s, i) in skill.steps" :key="i">{{ s }}</li></ol>
          <p v-if="skill.stepCount > skill.steps.length" class="lab">… 외 {{ skill.stepCount - skill.steps.length }}단계</p>
        </div>
        <div v-if="skill.tools?.length" class="block">
          <p class="lab">쓰는 도구</p>
          <div class="tools"><span v-for="t in skill.tools" :key="t">{{ t }}</span></div>
        </div>
        <button class="row" @click="sheet = true"><span>SKILL.md 전체 보기</span><Icon name="expand" :size="16" /></button>
      </div>

      <p class="cap">이 스킬을 쓰는 예약 작업</p>
      <div class="list glass">
        <button v-for="m in skill.missions" :key="m.id" class="row" @click="router.push('/settings/schedules')">
          <span>{{ m.name }}<span v-if="m.paused" class="tag">일시정지</span></span><small>{{ m.cron }}</small>
        </button>
        <p v-if="!skill.missions?.length" class="none">아직 없어요.</p>
      </div>
      <div class="chips">
        <button v-for="p in presets" :key="p.label" class="chip press" :class="{ on: pick === p }" @click="pick = pick === p ? null : p">{{ p.label }}</button>
      </div>
      <template v-if="pick">
        <textarea v-model="params" rows="2" placeholder='입력값(JSON) 예: {"channel":"@경제사냥꾼"}' />
        <button class="dark-btn" :disabled="busy" @click="schedule">{{ busy ? '등록하는 중…' : `${pick.label} 예약 만들기` }}</button>
      </template>
      <button class="pill-btn danger" @click="remove">스킬 삭제</button>
      <SkillSheet v-if="sheet" :skill="skill" @close="sheet = false" />
    </template>
  </div>
</template>

<style scoped>
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 14px; }
.list { border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.li { display: flex; align-items: center; gap: 12px; padding: 16px 0; border-bottom: 1px solid var(--hairline); text-align: left; }
.li:last-child { border-bottom: 0; }
.main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 450; display: flex; gap: 8px; align-items: center; word-break: break-all; }
.main small { color: var(--text-secondary); font-size: 13px; line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tag { font-size: 11.5px; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); font-weight: 400; margin-left: 6px; }
h2 { font-size: 28px; font-weight: 400; margin: 0 0 6px; word-break: break-all; }
.desc { margin: 0 0 10px; color: var(--text-secondary); font-size: 14.5px; line-height: 1.55; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 14px; }
.svc { font-size: 12.5px; padding: 3px 10px; border-radius: 9999px; background: var(--field-bg); }
.count { font-size: 12.5px; color: var(--text-secondary); }
.block { padding: 14px 0; border-bottom: 1px solid var(--hairline); }
.lab { margin: 0 0 6px; font-size: 12.5px; color: var(--text-secondary); }
.steps { margin: 0; padding-left: 1.3em; font-size: 14px; line-height: 1.55; }
.tools { display: flex; flex-wrap: wrap; gap: 5px; }
.tools span { font: 11.5px ui-monospace, Menlo, monospace; padding: 3px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--hairline); font-size: 15px; text-align: left; }
.row:last-child { border-bottom: 0; }
.row small { color: var(--text-secondary); font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
.none { margin: 14px 0; color: var(--text-secondary); font-size: 14px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.chip { height: 34px; padding: 0 13px; border-radius: 9999px; background: var(--field-bg); font-size: 13.5px; }
.chip.on { background: var(--ink); color: var(--ink-inverse); }
textarea { width: 100%; box-sizing: border-box; border: 0; outline: 0; border-radius: 14px; padding: 10px 14px; background: var(--field-bg); font: 13px ui-monospace, Menlo, monospace; resize: vertical; margin-bottom: 8px; }
.dark-btn { height: 40px; margin-bottom: 18px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.pill-btn { height: 38px; margin-top: 8px; }
.danger { color: var(--color-error); }
.err { color: var(--color-error); font-size: 13px; }
</style>
