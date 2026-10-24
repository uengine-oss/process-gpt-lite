<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import SkillSheet from './SkillSheet.vue'
import SkillShareCard from './SkillShareCard.vue'
import { servicesOf } from './skillMeta.js'
import { api } from '../api.js'

// A skill written by process-gpt's skill-creator, shown as a summary: what it does, which services
// it touches, its first steps. The full SKILL.md opens in a sheet. Saving uploads it as a tenant
// skill (deepagents /skills/upload); choosing a schedule also registers it as a mission (pg_cron).
const props = defineProps({ msg: Object })
const router = useRouter()
const c = computed(() => props.msg.content)
const services = computed(() => servicesOf(c.value.tools))
const presets = [
  { label: '저장만', cron: '' },
  { label: '매일 아침 8시', cron: '0 8 * * *' },
  { label: '하루 두 번(12·21시)', cron: '0 12,21 * * *' },
  { label: '평일 장중 매시', cron: '0 9-15 * * 1-5' },
]
const pick = ref(presets[0])
const params = ref('')
const busy = ref(false)
const err = ref('')
const sheet = ref(false)

async function save() {
  busy.value = true
  err.value = ''
  let p = {}
  try { p = params.value.trim() ? JSON.parse(params.value) : {} } catch { err.value = '입력값은 JSON 형식이어야 해요. 예: {"channel":"@경제사냥꾼"}'; busy.value = false; return }
  try {
    await api(`/skill-drafts/${props.msg.id}/save`, { method: 'POST', body: { cron: pick.value.cron || null, params: p, missionName: c.value.name } })
  } catch (e) { err.value = '저장하지 못했어요. ' + e.message.slice(0, 120) } finally { busy.value = false }
}
</script>

<template>
  <div class="skill">
    <div class="top">
      <span class="badge">{{ c.state === 'saved' ? '스킬' : '새 스킬 초안' }}</span>
      <button v-if="c.markdown" class="exp press" aria-label="자세히 보기" @click="sheet = true"><Icon name="expand" :size="15" /></button>
    </div>
    <h3 class="serif">{{ c.name }}</h3>
    <p v-if="c.description" class="desc">{{ c.description }}</p>
    <div v-if="services.length || c.stepCount" class="meta">
      <span v-for="s in services" :key="s" class="svc">{{ s }}</span>
      <span v-if="c.stepCount" class="count">절차 {{ c.stepCount }}단계</span>
    </div>
    <ol v-if="c.steps?.length" class="steps">
      <li v-for="(s, i) in c.steps.slice(0, 3)" :key="i">{{ s }}</li>
    </ol>
    <button v-if="c.markdown" class="more" @click="sheet = true">SKILL.md 전체 보기<Icon name="chevron" :size="14" /></button>

    <template v-if="c.state === 'saved' && c.visibility === 'private'">
      <p class="ok"><Icon name="check" :size="14" /> 내 스킬로 저장됐어요. 채팅에서 <code>/{{ c.skill }}</code> 로 바로 쓸 수 있어요.</p>
      <p v-if="c.cron" class="ok"><Icon name="clock" :size="14" /> 주기 실행 등록됨 · {{ c.cron }}</p>
      <SkillShareCard :skill="c.skill" :folder="c.folder" />
    </template>
    <template v-else-if="c.state === 'saved'">
      <p class="ok"><Icon name="check" :size="14" /> 테넌트 스킬로 저장됐어요. 채팅에서 <code>/{{ c.skill }}</code> 로 바로 쓸 수 있어요.</p>
      <p v-if="c.cron" class="ok"><Icon name="clock" :size="14" /> 주기 실행 등록됨 · {{ c.cron }}</p>
      <button class="pill-btn" @click="router.push(`/settings/skills/${encodeURIComponent(c.skill)}`)">스킬 관리에서 보기</button>
    </template>
    <template v-else>
      <div class="chips">
        <button v-for="p in presets" :key="p.label" class="chip press" :class="{ on: pick === p }" @click="pick = p">{{ p.label }}</button>
      </div>
      <textarea v-if="pick.cron" v-model="params" rows="2" placeholder='입력값(JSON) 예: {"channel":"@경제사냥꾼","sectors":["코스피","반도체"]}' />
      <button class="dark-btn" :disabled="busy" @click="save">{{ busy ? '저장하는 중…' : pick.cron ? '스킬 저장 + 주기 실행 등록' : '스킬로 저장' }}</button>
      <p v-if="err" class="err">{{ err }}</p>
    </template>
    <SkillSheet v-if="sheet" :skill="c" @close="sheet = false" />
  </div>
</template>

<style scoped>
.skill { width: 424px; max-width: 100%; border-radius: 24px; padding: 20px; background: var(--bubble-agent-bg); -webkit-backdrop-filter: blur(50px); backdrop-filter: blur(50px); box-shadow: var(--shadow-card); display: flex; flex-direction: column; gap: 10px; }
.top { display: flex; justify-content: space-between; align-items: center; }
.badge { font-size: 12px; color: var(--text-secondary); letter-spacing: .04em; }
.exp { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); }
h3 { margin: 0; font-size: 22px; font-weight: 400; overflow-wrap: anywhere; }
.desc { margin: 0; font-size: 14px; color: var(--text-secondary); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.svc { font-size: 12.5px; padding: 3px 10px; border-radius: 9999px; background: var(--field-bg); }
.count { font-size: 12.5px; color: var(--text-secondary); }
.steps { margin: 0; padding-left: 1.3em; font-size: 13.5px; line-height: 1.5; display: flex; flex-direction: column; gap: 2px; }
.steps li { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.more { align-self: flex-start; display: inline-flex; align-items: center; gap: 2px; font-size: 13px; color: var(--text-secondary); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { height: 34px; padding: 0 13px; border-radius: 9999px; background: var(--field-bg); font-size: 13.5px; }
.chip.on { background: var(--ink); color: var(--ink-inverse); }
textarea { border: 0; outline: 0; border-radius: 14px; padding: 10px 14px; background: var(--field-bg); font: 13px ui-monospace, Menlo, monospace; resize: vertical; }
.ok { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 14px; }
code { font-size: 13px; background: var(--field-bg); padding: 1px 6px; border-radius: 6px; }
.pill-btn { align-self: flex-start; height: 36px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.err { margin: 0; color: var(--color-error); font-size: 13px; }
</style>
