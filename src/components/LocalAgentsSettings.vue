<script setup>
// 설정 › 계정 › 내 컴퓨터의 에이전트 (server lib/localAgents, desktop/src/runner): in the desktop app, this computer — linked or not, its
// CLI agents (Claude Code · Codex · OpenHands: installed, version, signed in) and the person's two switches (local runs on/off, ask before
// each run); everywhere, the person's desktops with 「연결 해제」(the token is revoked, the link closes).
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { runner, pairThis, disconnectThis, setPrefs, detectClis } from '../localRunner.js'

const app = useApp()
const devices = ref([])
const err = ref('')
const busy = ref('')
const st = computed(() => runner.status)
const here = computed(() => st.value?.deviceId || null)
const clis = computed(() => Object.entries(st.value?.clis || {}))
async function load() { devices.value = await api('/local-agents/devices').catch((e) => { err.value = e.message; return [] }) }
onMounted(load)
async function run(name, fn) {
  busy.value = name; err.value = ''
  try { await fn(); await load() } catch (e) { err.value = e.message } finally { busy.value = '' }
}
const revoke = (d) => run(`revoke-${d.id}`, async () => {
  if (d.id === here.value) await disconnectThis({ optOut: true })
  else await api(`/local-agents/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' })
})
const when = (d) => (d ? new Date(d).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const cliLine = (c) => (!c.installed ? '설치돼 있지 않아요' : [c.version, c.loggedIn === true ? '로그인됨' : c.loggedIn === false ? '로그인 필요' : '', c.runnable === false ? '아직 실행하지 않음' : ''].filter(Boolean).join(' · '))
</script>

<template>
  <div class="la" data-test="local-agents-settings">
    <p class="cap">내 컴퓨터의 에이전트</p>
    <div class="list glass">
      <template v-if="runner.desktop">
        <div class="li">
          <div class="main">
            <b>이 컴퓨터 · {{ st?.connected ? '연결됨' : st?.paired ? (st?.refused ? '연결이 끊겼어요' : '연결 중…') : '연결 안 됨' }}</b>
            <small>{{ st?.device?.name || st?.deviceName }} — 프로세스의 단계가 이 컴퓨터의 Claude Code · Codex 로 돌 때 쓰여요</small>
          </div>
          <button v-if="!st?.paired || st?.refused" class="pill-btn sm" :disabled="!!busy" data-test="local-pair" @click="run('pair', () => pairThis(app.me))">연결하기</button>
          <button v-else class="pill-btn sm" :disabled="!!busy" data-test="local-unpair" @click="run('unpair', () => disconnectThis({ optOut: true }))">연결 해제</button>
        </div>
        <div v-for="[id, c] in clis" :key="id" class="li cli" :data-cli="id">
          <div class="main"><b>{{ c.label }}</b><small>{{ cliLine(c) }}</small></div>
        </div>
        <!-- how steps run here: the person's own CLI in a terminal (else headless — no terminal module in this build) -->
        <div v-if="st?.terminal != null" class="li" data-test="local-terminal-mode">
          <div class="main"><b>실행 방식</b><small>{{ st.terminal ? '내 터미널 그대로 — 내 CLI 의 로그인 · 설정으로 돌고, 실행 카드에서 그 터미널을 봐요' : '터미널 없이(헤드리스) — 이 앱에서 터미널 모듈을 불러오지 못했어요' }}</small></div>
        </div>
        <div class="li">
          <div class="main"><b>이 컴퓨터에서 단계 실행</b><small>끄면 이 컴퓨터로 단계가 오지 않아요(활동 설정대로 서버에 맡기거나 기다려요)</small></div>
          <input type="checkbox" class="sw" :checked="st?.prefs?.enabled !== false" data-test="local-enabled" @change="(e) => setPrefs({ enabled: e.target.checked })" />
        </div>
        <div class="li">
          <div class="main"><b>실행 전에 묻기</b><small>단계가 오면 실행할지 창으로 물어요</small></div>
          <input type="checkbox" class="sw" :checked="st?.prefs?.ask === true" data-test="local-ask" @change="(e) => setPrefs({ ask: e.target.checked })" />
        </div>
        <div class="li"><div class="main"><small>CLI 를 새로 설치했으면 다시 찾아 주세요</small></div><button class="pill-btn sm" :disabled="!!busy" @click="run('detect', detectClis)">다시 찾기</button></div>
      </template>
      <div v-else class="li"><div class="main"><b>데스크톱 앱에서 연결해요</b><small>Process GPT Lite 데스크톱 앱으로 로그인하면 그 컴퓨터의 Claude Code · Codex 가 내 단계를 실행할 수 있어요</small></div></div>
    </div>
    <template v-if="devices.length">
      <p class="cap">연결한 데스크톱</p>
      <div class="list glass" data-test="local-devices">
        <div v-for="d in devices" :key="d.id" class="li" :class="{ off: d.revoked }">
          <div class="main">
            <b>{{ d.name }}<template v-if="d.id === here"> · 이 컴퓨터</template></b>
            <small>{{ d.revoked ? '연결 해제됨' : d.online ? '켜져 있음' : `꺼져 있음${d.lastSeenAt ? ` · ${when(d.lastSeenAt)}` : ''}` }}<template v-for="(c, k) in d.caps?.clis || {}" :key="k"><template v-if="c.installed"> · {{ k === 'claude-code' ? 'Claude Code' : k === 'codex' ? 'Codex' : k }} {{ c.version }}</template></template></small>
          </div>
          <button v-if="!d.revoked" class="pill-btn sm" :disabled="!!busy" @click="revoke(d)">연결 해제</button>
        </div>
      </div>
    </template>
    <p v-if="err" class="err">{{ err }}</p>
  </div>
</template>

<style scoped>
/* the settings sheet's own list look (SettingsSheet.vue: its styles are scoped to it) */
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 18px; }
.list { width: 100%; border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.li { display: flex; align-items: center; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--hairline); }
.li:last-child { border-bottom: 0; }
.li .main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.li b { font-weight: 450; font-size: 16px; }
.li small { color: var(--text-secondary); font-size: 14px; }
.li.cli { padding: 10px 0 10px 14px; }
.li.cli b { font-size: 15px; }
.pill-btn.sm { height: 34px; padding: 0 14px; font-size: 14px; flex: none; }
.li.off { opacity: .5; }
.sw { width: 20px; height: 20px; flex: none; accent-color: var(--ink); }
.err { color: var(--color-error); font-size: 13px; margin: 6px 4px; }
</style>
