<script setup>
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { connectInBrowser, connectOnPhone } from '../googleConnect.js'

// hark-style "연결" cards. Each connector is also a process-gpt system (systems registry) reached
// through its own mcp-hub server, so connecting here makes its tools usable by agents and skills.
const list = ref([])
const hub = ref(null)
const google = ref(false)
const editing = ref(null)
const token = ref('')
const busy = ref(false)
const err = ref('')
const how = {
  google: { kind: 'oauth', hint: 'Gmail·캘린더·Drive·YouTube 권한으로 연결해요. 서버 브라우저에서 로그인하면 NotebookLM 같은 Google 사이트도 함께 로그인돼요. 캘린더 등록이 안 되면 다시 연결해 권한을 넓혀요.' },
  // public data without a key; the API key (or the Google account) adds popular videos and search
  youtube: { kind: 'key', ph: 'AIza…', link: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com', linkText: '키 만들기',
    keyHint: 'Google Cloud 콘솔에서 YouTube Data API v3 를 켜고 「사용자 인증 정보 › API 키」를 만들어 붙여 넣으세요.' },
  slack: { kind: 'token', hint: 'Slack 사용자 토큰(xoxp-…)을 붙여 넣으세요.', ph: 'xoxp-…', link: 'https://api.slack.com/apps' },
  github: { kind: 'token', hint: 'Personal Access Token(repo 범위)을 붙여 넣으세요.', ph: 'ghp_… 또는 github_pat_…', link: 'https://github.com/settings/tokens' },
  notion: { kind: 'token', hint: '내부 통합 시크릿을 붙여 넣고, 쓸 페이지를 통합에 공유하세요.', ph: 'ntn_… / secret_…', link: 'https://www.notion.so/my-integrations' },
}
const favicon = { google: 'google.com', youtube: 'youtube.com', slack: 'slack.com', github: 'github.com', notion: 'notion.so' }

function hintOf(c) {
  if (c.name !== 'youtube') return how[c.name]?.hint
  const s = c.status || {}
  if (s.key === 'vault') return 'API 키로 인기 영상·검색까지 써요. 채널 새 영상·자막은 키 없이도 돼요.'
  if (s.key === 'server') return '서버에 둔 API 키로 인기 영상·검색까지 써요. 내 키를 넣으면 그 키를 먼저 써요.'
  if (s.google) return 'Google 계정으로 인기 영상·검색까지 써요. 채널 새 영상·자막은 키 없이도 돼요.'
  return 'API 키 없이도 채널 새 영상·자막은 볼 수 있어요. 인기 영상·검색은 YouTube API 키나 Google 계정 연결이 필요해요.'
}
const againLabel = (c) => how[c.name]?.kind === 'oauth' ? '다시 연결(권한 넓히기)' : how[c.name]?.kind === 'key' ? (c.status?.key === 'vault' ? 'API 키 바꾸기' : 'API 키 넣기') : '토큰 바꾸기'

async function load() {
  const r = await api('/connectors')
  // (agent-only tools such as the built-in browser have no card)
  list.value = r.connectors.filter((c) => how[c.name])
  hub.value = r.hub
  google.value = !!(await api('/config').catch(() => null))?.google
}
onMounted(load)

const app = useApp()
const router = useRouter()
const gErr = ref('')
// Google: in the server browser by default (lib/googleConnect.js), 휴대폰에서 연결 for the mail alone
async function connectGoogle(where) {
  gErr.value = ''
  busy.value = true
  try {
    if (where === 'phone') await connectOnPhone()
    else await connectInBrowser(app, router)
  } catch (e) { gErr.value = e.message } finally { busy.value = false }
}
function connect(c) {
  if (how[c.name].kind === 'oauth') return connectGoogle('browser')
  editing.value = c.name
  token.value = ''
  err.value = ''
}
async function saveToken() {
  busy.value = true
  err.value = ''
  try {
    await api(`/connectors/${editing.value}/token`, { method: 'POST', body: { token: token.value } })
    editing.value = null
    await load()
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="cards">
    <div v-for="c in list" :key="c.name" class="card glass" :class="{ on: c.connected }">
      <div class="top">
        <img :src="`https://www.google.com/s2/favicons?domain=${favicon[c.name]}&sz=64`" alt="" />
        <div class="t"><b>{{ c.title }}</b><small>{{ hintOf(c) }}</small></div>
        <span v-if="c.connected" class="state"><Icon name="check" :size="14" /> 연결됨</span>
        <button v-else-if="how[c.name]?.kind !== 'public'" class="pill-btn press" :disabled="(how[c.name]?.kind === 'oauth' && !google) || busy" :title="how[c.name]?.kind === 'oauth' && !google ? '회사 관리자가 설정 › 시스템 설정에서 Google 연결을 켜야 해요' : undefined" :data-testid="`connect-${c.name}`" @click="connect(c)">연결</button>
      </div>
      <template v-if="how[c.name]?.kind === 'oauth'">
        <small v-if="!google" class="key-hint" data-testid="google-off">회사 관리자가 설정 › 시스템 설정 › 회사 Google 연결에 OAuth 클라이언트를 넣으면 연결할 수 있어요.</small>
        <button v-else class="re" :disabled="busy" data-testid="connect-google-phone" @click="connectGoogle('phone')">휴대폰에서 연결 · 메일만</button>
        <small v-if="gErr" class="key-err" data-testid="google-err">{{ gErr }}</small>
      </template>
      <div class="tools">
        <span v-for="t in c.tools" :key="t" class="tool">{{ t }}</span>
      </div>
      <button v-if="c.connected && how[c.name]?.kind !== 'public'" class="re" @click="connect(c)">{{ againLabel(c) }}</button>
      <form v-if="editing === c.name" class="tok" @submit.prevent="saveToken">
        <input v-model="token" type="password" :placeholder="how[c.name].ph" autocomplete="off" />
        <a :href="how[c.name].link" target="_blank" rel="noopener">{{ how[c.name].linkText || '토큰 만들기' }}</a>
        <button class="dark-btn" :disabled="!token || busy">저장</button>
        <small v-if="how[c.name].keyHint" class="key-hint">{{ how[c.name].keyHint }}</small>
        <small v-if="err" class="key-err">{{ err }}</small>
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
.tok small { flex-basis: 100%; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); padding: 0 6px; }
.card > .key-hint, .card > .key-err { font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); }
.tok .key-err, .card > .key-err { color: var(--color-error); }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.hub { display: flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--text-secondary); margin: 2px 6px; }
</style>
