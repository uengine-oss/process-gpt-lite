<script setup>
import { ref, onMounted } from 'vue'
import Icon from './Icon.vue'
import { api } from '../api.js'

// hark-style "연결" cards. Each connector is also a process-gpt system (systems registry) reached
// through its own mcp-hub server, so connecting here makes its tools usable by agents and skills.
const list = ref([])
const hub = ref(null)
const editing = ref(null)
const token = ref('')
const busy = ref(false)
const how = {
  google: { kind: 'oauth', hint: 'Gmail·캘린더·Drive·YouTube 권한으로 연결합니다. 캘린더 등록이 안 되면 다시 연결해 권한을 넓히세요.' },
  youtube: { kind: 'public', hint: '공개 데이터라 연결이 필요 없습니다.' },
  slack: { kind: 'token', hint: 'Slack 사용자 토큰(xoxp-…)을 붙여 넣으세요.', ph: 'xoxp-…', link: 'https://api.slack.com/apps' },
  github: { kind: 'token', hint: 'Personal Access Token(repo 범위)을 붙여 넣으세요.', ph: 'ghp_… 또는 github_pat_…', link: 'https://github.com/settings/tokens' },
  notion: { kind: 'token', hint: '내부 통합 시크릿을 붙여 넣고, 쓸 페이지를 통합에 공유하세요.', ph: 'ntn_… / secret_…', link: 'https://www.notion.so/my-integrations' },
}
const favicon = { google: 'google.com', youtube: 'youtube.com', slack: 'slack.com', github: 'github.com', notion: 'notion.so' }

async function load() {
  const r = await api('/connectors')
  list.value = r.connectors
  hub.value = r.hub
}
onMounted(load)

function connect(c) {
  if (how[c.name].kind === 'oauth') { window.location.href = '/api/auth/google/start?mail=1'; return }
  editing.value = c.name
  token.value = ''
}
async function saveToken() {
  busy.value = true
  try {
    await api(`/connectors/${editing.value}/token`, { method: 'POST', body: { token: token.value } })
    editing.value = null
    await load()
  } finally { busy.value = false }
}
</script>

<template>
  <div class="cards">
    <div v-for="c in list" :key="c.name" class="card glass" :class="{ on: c.connected }">
      <div class="top">
        <img :src="`https://www.google.com/s2/favicons?domain=${favicon[c.name]}&sz=64`" alt="" />
        <div class="t"><b>{{ c.title }}</b><small>{{ how[c.name]?.hint }}</small></div>
        <span v-if="c.connected" class="state"><Icon name="check" :size="14" /> 연결됨</span>
        <button v-else-if="how[c.name]?.kind !== 'public'" class="pill-btn press" @click="connect(c)">연결</button>
      </div>
      <div class="tools">
        <span v-for="t in c.tools" :key="t" class="tool">{{ t }}</span>
      </div>
      <button v-if="c.connected && how[c.name]?.kind !== 'public'" class="re" @click="connect(c)">{{ how[c.name]?.kind === 'oauth' ? '다시 연결(권한 넓히기)' : '토큰 바꾸기' }}</button>
      <form v-if="editing === c.name" class="tok" @submit.prevent="saveToken">
        <input v-model="token" type="password" :placeholder="how[c.name].ph" autocomplete="off" />
        <a :href="how[c.name].link" target="_blank" rel="noopener">토큰 만들기</a>
        <button class="dark-btn" :disabled="!token || busy">저장</button>
      </form>
    </div>
    <p v-if="hub" class="hub"><Icon name="lock" :size="13" /> 토큰은 암호화된 보관함에만 저장되고, 연결한 서비스는 process-gpt mcp-hub 에서 이 계정에 묶입니다({{ hub.bound }}개).</p>
  </div>
</template>

<style scoped>
.cards { display: flex; flex-direction: column; gap: 10px; margin-bottom: 18px; }
.card { border-radius: 22px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.top { display: flex; align-items: center; gap: 12px; }
.top img { width: 28px; height: 28px; border-radius: 8px; background: #fff; padding: 3px; }
.t { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.t b { font-weight: 500; }
.t small { font-size: 12.5px; color: var(--text-secondary); line-height: 1.4; }
.state { display: inline-flex; align-items: center; gap: 4px; font-size: 13px; color: var(--color-success); white-space: nowrap; }
.pill-btn { height: 34px; padding: 0 16px; font-size: 14px; }
.tools { display: flex; flex-wrap: wrap; gap: 5px; }
.tool { font-size: 11.5px; padding: 3px 8px; border-radius: 9999px; background: var(--field-bg); color: var(--text-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.card:not(.on) .tool { opacity: .55; }
.re { align-self: flex-start; font-size: 13px; color: var(--text-secondary); text-decoration: underline; text-underline-offset: 3px; }
.tok { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.tok input { flex: 1; min-width: 200px; height: 40px; border-radius: 9999px; border: 0; outline: 0; padding: 0 16px; background: var(--field-bg); }
.tok a { font-size: 13px; color: var(--text-secondary); }
.tok .dark-btn { height: 40px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.hub { display: flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--text-secondary); margin: 2px 6px; }
</style>
