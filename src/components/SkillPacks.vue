<script setup>
// 업무 팩: one trade's knowledge as skills (server/lib/skillInstall.js, skills/packs/<팩>/). None is part of
// the basic install; an administrator turns one on for the company, which installs its skills for every
// agent here, and off again (the copies the company did not change are taken away).
import { ref, onMounted } from 'vue'
import { api } from '../api.js'
import { isEnglish } from '../i18n/lang.js'

const packs = ref([])
const admin = ref(false)
const busy = ref('')
const err = ref('')
const loaded = ref(false)
const tx = (v) => (v && typeof v === 'object' ? v[isEnglish ? 'en' : 'ko'] || v.ko || '' : v || '')
// each skill's state in the company (pro_skill_installs)
const STATE = { installed: '설치됨', diverged: '회사가 고친 스킬 · 그대로 둠', conflict: '같은 이름의 스킬이 있어 설치하지 않음', disabled: '꺼짐', failed: '설치 실패', absent: '설치 안 됨' }

async function load() {
  err.value = ''
  try { const r = await api('/packs'); packs.value = r.packs || []; admin.value = !!r.admin } catch (e) { err.value = '업무 팩을 불러오지 못했어요.' } finally { loaded.value = true }
}
onMounted(load)

async function toggle(p) {
  busy.value = p.name
  err.value = ''
  try {
    const r = await api(`/packs/${encodeURIComponent(p.name)}`, { method: 'PUT', body: { enabled: !p.enabled } })
    packs.value = r.packs || packs.value
  } catch (e) { err.value = e.code === 'ADMIN_ONLY' || e.status === 403 ? '관리자만 업무 팩을 켜고 끌 수 있어요.' : '바꾸지 못했어요. 잠시 뒤 다시 해 주세요.' } finally { busy.value = '' }
}
</script>

<template>
  <section v-if="loaded && packs.length" class="packs" data-test="skill-packs">
    <p class="cap">업무 팩 · 업종 지식을 묶은 스킬이에요. 기본 설치에는 없고, 켜면 이 회사의 에이전트가 쓸 수 있게 설치돼요.</p>
    <div class="list glass">
      <div v-for="p in packs" :key="p.name" class="pk" :data-test="`pack-${p.name}`">
        <div class="li">
          <div class="main">
            <b data-no-i18n>{{ tx(p.title) }} <span class="tag">v{{ p.version }}</span></b>
            <small data-no-i18n>{{ tx(p.summary) }}</small>
          </div>
          <button v-if="admin" class="pill-btn sm" :class="{ on: p.enabled }" :disabled="busy === p.name" :aria-pressed="p.enabled" data-test="pack-toggle" @click="toggle(p)">
            {{ busy === p.name ? '바꾸는 중…' : p.enabled ? '켜짐' : '꺼짐' }}
          </button>
          <span v-else class="tag">{{ p.enabled ? '켜짐' : '꺼짐' }}</span>
        </div>
        <ul v-if="p.enabled || p.skills.some((s) => s.state !== 'absent')" class="sk">
          <li v-for="s in p.skills" :key="s.name" :data-state="s.state"><code>{{ s.name }}</code> <span>{{ STATE[s.state] || s.state }}</span></li>
        </ul>
      </div>
    </div>
    <p v-if="err" class="bad">{{ err }}</p>
  </section>
</template>

<style scoped>
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 14px; line-height: 1.5; }
.list { border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.pk { border-bottom: 1px solid var(--hairline); padding-bottom: 10px; }
.pk:last-child { border-bottom: 0; }
.li { display: flex; align-items: center; gap: 12px; padding: 16px 0 8px; text-align: left; }
.main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.main b { font-weight: 450; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.main small { color: var(--text-secondary); font-size: 13px; line-height: 1.45; }
.tag { font-size: 11.5px; padding: 2px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); font-weight: 400; }
.pill-btn.sm { height: 34px; flex: none; }
.pill-btn.on { background: var(--ink); color: var(--ink-inverse); }
.sk { list-style: none; margin: 0; padding: 0 0 6px; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--text-secondary); }
.sk code { font: 12px ui-monospace, Menlo, monospace; color: var(--text-primary); }
.sk li[data-state='conflict'] span, .sk li[data-state='failed'] span { color: var(--color-error); }
.bad { font-size: 13px; color: var(--color-error); margin: 0 0 12px; }
</style>
