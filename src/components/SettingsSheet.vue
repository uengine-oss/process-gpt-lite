<script setup>
import { ref, computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from './Icon.vue'
import Wordmark from './Wordmark.vue'
import ConnectorCards from './ConnectorCards.vue'
import MissionList from './MissionList.vue'
import SkillList from './SkillList.vue'
import TeamRoles from './TeamRoles.vue'
import UsagePlan from './UsagePlan.vue'
import MailConnect from './MailConnect.vue'
import DemoMailPractice from './DemoMailPractice.vue'
import LangSwitch from '../i18n/LangSwitch.vue'
import { MAIN_LANGS, uiLangFor } from '../i18n/mainLangs.js'
import { lang as uiLang, setLang } from '../i18n/lang.js'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import { useSky } from '../stores/sky.js'
import { BASE } from '../base.js'

const route = useRoute()
const router = useRouter()
const app = useApp()
const sky = useSky()
const page = computed(() => route.params.page)
const sub = computed(() => route.params.sub)
const titles = { usage: '사용량·요금제', schedules: '예약된 작업', team: '팀·역할', skills: '스킬', accounts: '계정', wallet: '지갑', system: '시스템 설정', security: '보안', profile: '프로필' }

const schedules = ref([])
const vault = ref([])
const cfg = ref(null)
const filter = ref('all')
const login = ref({ site: '', username: '', password: '' })
const card = ref({ name: '', number: '', exp: '', cvv: '', zip: '' })
const apiKey = ref({ site: '', key: '' })
const edit = ref({ username: '', password: '' })
const formError = ref('')
const audit = ref([])
const proof = ref(null)
const checking = ref(false)

async function load() {
  formError.value = ''
  if (page.value === 'schedules') schedules.value = await api('/schedules')
  if (['accounts', 'wallet'].includes(page.value)) vault.value = await api('/vault')
  if (page.value === 'security') {
    cfg.value = await (await fetch(BASE + '/api/config')).json()
    audit.value = await api('/vault/audit?limit=30')
  }
}
watch([page, sub], load, { immediate: true })

const shown = computed(() => vault.value.filter((v) => v.kind !== 'card' && (filter.value === 'all' || v.kind === filter.value)))
const cards = computed(() => vault.value.filter((v) => v.kind === 'card'))
const kindLabel = { oauth: '연결', login: '로그인', apikey: 'API 키' }
const statusText = { rejected: '사이트에서 이 비밀번호를 거부했습니다', not_logged_in: '아직 로그인하지 않았습니다', captured: '브라우저에서 입력한 정보 · 저장할지 확인해 주세요' }
const editing = computed(() => (page.value === 'accounts' && /^[0-9a-f-]{36}$/.test(sub.value || '') ? vault.value.find((v) => v.id === sub.value) : null))
const used = (v) => (v.last_used_at ? `${new Date(v.last_used_at).toLocaleDateString('ko-KR')} 사용 · ${v.use_count}회` : '아직 사용 안 함')
const errorOf = (e) => { try { return JSON.parse(e.message).error } catch { return '저장하지 못했어요.' } }
// what each audit row means, in the user's words (never a value)
const auditText = (a) => {
  const what = a.kind === 'card' ? '카드' : a.kind === 'secret' ? (a.detail?.label || '일회용 값') : `${a.site || ''} ${kindLabel[a.kind] || ''}`.trim()
  const field = { username: '아이디', password: '비밀번호', card_number: '번호', card_exp: '만료일', card_cvv: 'CVC', card_name: '소유자' }[a.detail?.field]
  return {
    create: `${what} 저장`, update: `${what} 변경`, delete: `${what} 삭제`, capture: `${what} 입력을 감지해 보관`,
    confirm: `${what} 저장 확인`, discard: `${what} 보관하지 않음`, reject: `${what} — 사이트가 비밀번호를 거부`,
    fill: `${what} ${field || ''} · 브라우저 작업에 입력`, one_time: `${what} · 페이지에 바로 입력 (저장 안 함)`,
    rotate_dek: '데이터 키(DEK) 교체 · 항목 재암호화', rotate_kek: '마스터 키(KEK) 교체 · 데이터 키 다시 감쌈',
  }[a.action] || a.action
}
const actorText = { user: '나', 'browser-agent': '브라우저 에이전트', mail: '메일', connector: '커넥터', admin: '관리자' }
async function runProof() {
  checking.value = true
  try { proof.value = await api('/vault/proof') } finally { checking.value = false }
}
const checkText = {
  decrypts_with_user_dek: '내 DEK로만 열림', rejects_other_site: '다른 사이트로 옮기면 안 열림', rejects_other_user: '다른 사용자로 옮기면 안 열림',
  rejects_tampering: '1비트 변조 감지', rejects_kek_as_dek: 'KEK로 직접 열 수 없음', no_plaintext_in_row: 'DB 행에 평문 없음',
}
const schedTarget = (s) => (s.thread_kind === 'project' ? `프로젝트 "${s.thread_title}"에 게시` : '채팅에 게시')

async function delSchedule(s) { await api(`/schedules/${s.id}`, { method: 'DELETE' }); load() }
async function delVault(v) { await api(`/vault/${v.id}`, { method: 'DELETE' }); load() }
async function confirmVault(v) { await api(`/vault/${v.id}/confirm`, { method: 'POST', body: {} }); load() }
async function save(fn, back) {
  formError.value = ''
  try { await fn(); router.push(back); load() } catch (e) { formError.value = errorOf(e) }
}
const addLogin = () => save(async () => {
  await api('/vault', { method: 'POST', body: { kind: 'login', site: login.value.site, data: { username: login.value.username, password: login.value.password } } })
  login.value = { site: '', username: '', password: '' }
}, '/settings/accounts')
const addKey = () => save(async () => {
  await api('/vault', { method: 'POST', body: { kind: 'apikey', site: apiKey.value.site, data: { key: apiKey.value.key } } })
  apiKey.value = { site: '', key: '' }
}, '/settings/accounts')
const addCard = () => save(async () => {
  await api('/vault', { method: 'POST', body: { kind: 'card', site: 'wallet', data: { ...card.value, number: card.value.number.replace(/\s/g, '') } } })
  card.value = { name: '', number: '', exp: '', cvv: '', zip: '' }
}, '/settings/wallet')
const saveEdit = () => save(async () => {
  await api(`/vault/${editing.value.id}`, { method: 'PATCH', body: { data: { username: edit.value.username, password: edit.value.password } } })
  edit.value = { username: '', password: '' }
}, '/settings/accounts')
const fmtCard = (e) => { card.value.number = e.target.value.replace(/\D/g, '').slice(0, 16).replace(/(\d{4})(?=\d)/g, '$1 ') }
const fmtExp = (e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 4); card.value.exp = v.length > 2 ? `${v.slice(0, 2)}/${v.slice(2)}` : v }
async function pollMail() { await api('/mail/poll', { method: 'POST' }) }
// 계정 › 내 정보: the name teammates and the greeting use (an e-mail sign-in starts with the address's local part)
// 계정 › 내 정보 › 주 언어: the language I speak in meetings and read messages in (others are interpreted
// and translated into it). The screens are Korean or English: another main language gets the English ones.
const mainLang = ref('')
const mainSaved = ref('')
watch(() => app.me?.mainLang, (v) => { mainLang.value = v || 'ko' }, { immediate: true })
async function saveMain() {
  const v = mainLang.value
  const r = await api('/me/main-lang', { method: 'PUT', body: { lang: v } })
  app.me = { ...app.me, mainLang: r.mainLang, mainLangSet: r.mainLang }
  mainSaved.value = '저장했어요'
  setTimeout(() => { mainSaved.value = '' }, 2000)
  if (v !== 'ko' && v !== 'en' && uiLang !== uiLangFor(v)) await setLang(uiLangFor(v))
}
const myName = ref('')
const nameSaved = ref('')
watch(() => app.me?.user?.name, (n) => { myName.value = n || '' }, { immediate: true })
async function saveName() {
  const name = myName.value.trim()
  if (!name) return
  await api('/profile', { method: 'POST', body: { name } })
  app.me = await api('/me')
  nameSaved.value = '저장했어요'
  setTimeout(() => { nameSaved.value = '' }, 2000)
}
// 계정 › 연결 › 메일: switch Gmail ↔ IMAP ↔ 데모 메일함 with the onboarding sheet (MailConnect)
const mailSheet = ref(false)
const mailLabel = { gmail: 'Gmail', imap: 'IMAP', demo: '데모 메일함' }
async function mailClosed() {
  mailSheet.value = false
  app.me = await api('/me')
}
const simLabel = computed(() => (sky.simHour == null ? '실시간' : `${Math.floor(sky.simHour)}:${String(Math.round((sky.simHour % 1) * 60)).padStart(2, '0')}`))
</script>

<template>
  <div class="settings scroll">
    <button class="x press" aria-label="닫기" @click="router.push('/chat')"><Icon name="close" :size="20" /></button>

    <div v-if="!page" class="home blur-in">
      <div class="avatar">{{ (app.me?.user?.name || '?').slice(0, 1) }}</div>
      <h2>{{ app.me?.user?.name }}</h2>
      <p class="mail">{{ app.me?.user?.email }}</p>
      <div class="plan"><Wordmark :size="18" /></div>
      <div class="list glass">
        <button v-for="(t, k) in titles" :key="k" @click="router.push(`/settings/${k}`)">{{ t }}<Icon name="chevron" :size="16" /></button>
      </div>
      <div class="list glass"><button class="danger" @click="app.logout()">로그아웃</button></div>
    </div>

    <div v-else class="page blur-in" :key="page + (sub || '')">
      <div class="ph">
        <button class="back press" aria-label="뒤로" @click="router.push(sub ? `/settings/${page}` : '/settings')"><Icon name="back" :size="20" /></button>
        <h1>{{ page === 'skills' && sub ? '스킬' : editing ? '로그인 수정' : sub === 'new' ? (page === 'wallet' ? '카드 추가' : page === 'accounts' ? '로그인 추가' : '추가') : sub === 'key' ? 'API 키 추가' : titles[page] }}</h1>
      </div>

      <!-- scheduled tasks -->
      <MissionList v-if="page === 'schedules'" />

      <!-- teammates and process role holders -->
      <TeamRoles v-if="page === 'team'" />

      <!-- usage windows, plans, seats (server lib/plans) -->
      <UsagePlan v-if="page === 'usage'" />

      <!-- tenant skills -->
      <SkillList v-if="page === 'skills'" :name="sub" />

      <!-- accounts (vault) -->
      <template v-if="page === 'accounts' && !sub">
        <p class="cap">내 정보</p>
        <form class="list glass" @submit.prevent="saveName">
          <div class="li">
            <div class="main"><b>이름</b><small>팀원 목록과 인사에 보이는 이름이에요</small></div>
            <input v-model="myName" class="nm" aria-label="이름" maxlength="40" placeholder="이름" />
            <button class="pill-btn sm" :disabled="!myName.trim() || myName.trim() === app.me?.user?.name">{{ nameSaved || '저장' }}</button>
          </div>
          <div class="li lang">
            <div class="main"><b>언어 / Language</b><small>화면과 비서의 답이 이 언어로 나와요</small></div>
            <LangSwitch compact />
          </div>
          <div class="li lang">
            <div class="main"><b>주 언어 / Main language</b><small>{{ mainSaved || '회의에서 말하고 듣는 언어, 메시지를 읽는 언어예요. 다른 언어로 된 말과 메시지는 AI가 이 언어로 통역·번역해요' }}</small></div>
            <select v-model="mainLang" class="msel" data-no-i18n data-test="main-lang" aria-label="주 언어" @change="saveMain">
              <option v-for="[code, name] in MAIN_LANGS" :key="code" :value="code">{{ name }}</option>
            </select>
          </div>
        </form>
        <p class="cap">연결</p>
        <div class="list glass">
          <div class="li">
            <span class="fav mailic"><Icon name="doc" :size="18" /></span>
            <div class="main"><b>메일 · {{ app.me?.mail ? mailLabel[app.me.mail.provider] || app.me.mail.provider : '연결 안 됨' }}</b><small>{{ app.me?.mail?.address || 'Gmail·IMAP·데모 메일함 중 하나로 연결해요' }}</small></div>
            <button class="pill-btn sm" @click="mailSheet = true">{{ app.me?.mail ? '연결 바꾸기' : '연결하기' }}</button>
          </div>
          <div v-if="app.me?.mail?.provider === 'demo'" class="li col">
            <div class="main"><b>연습 메일 받기</b><small>가상의 거래처 메일을 데모 메일함으로 보내요</small></div>
            <DemoMailPractice />
          </div>
        </div>
        <ConnectorCards />
        <p class="cap">로그인 · API 키</p>
        <div class="list glass">
          <div v-for="v in shown" :key="v.id" class="li">
            <img class="fav" :src="`https://www.google.com/s2/favicons?domain=${v.site}&sz=64`" alt="" />
            <button class="main" :disabled="v.kind !== 'login'" @click="router.push(`/settings/accounts/${v.id}`)">
              <b>{{ v.site }}</b><small>{{ v.label }}</small>
              <small v-if="v.status" :class="v.status === 'captured' ? 'warn' : 'bad'">{{ statusText[v.status] }}</small>
              <small v-else-if="v.kind === 'login'" class="dim">{{ used(v) }}</small>
            </button>
            <button v-if="v.status === 'captured'" class="pill-btn sm" @click="confirmVault(v)">저장</button>
            <span v-else class="tag">{{ kindLabel[v.kind] }}</span>
            <button aria-label="삭제" @click="delVault(v)"><Icon name="trash" :size="20" /></button>
          </div>
        </div>
        <div class="tabs">
          <button v-for="(t, k) in { all: '전체', oauth: '연결', login: '로그인', apikey: 'API 키' }" :key="k" :class="{ on: filter === k }" @click="filter = k">{{ t }}</button>
        </div>
        <div class="row2">
          <button class="pill-btn" @click="router.push('/settings/accounts/new')">+ 로그인 추가</button>
          <button class="pill-btn" @click="router.push('/settings/accounts/key')">+ API 키 추가</button>
        </div>
      </template>
      <form v-if="page === 'accounts' && sub === 'new'" class="form glass" @submit.prevent="addLogin">
        <input v-model="login.site" class="in" placeholder="사이트 (예: partners.example.com)" />
        <input v-model="login.username" class="in" placeholder="아이디 또는 이메일" autocomplete="off" />
        <input v-model="login.password" class="in" type="password" placeholder="비밀번호" autocomplete="new-password" />
        <p v-if="formError" class="ferr">{{ formError }}</p>
        <div class="fb"><span><span class="serif">process gpt</span>로 보호됨</span><button class="dark-btn" :disabled="!login.site || !login.password">저장</button></div>
      </form>
      <form v-if="editing" class="form glass" @submit.prevent="saveEdit">
        <div class="li flat"><img class="fav" :src="`https://www.google.com/s2/favicons?domain=${editing.site}&sz=64`" alt="" /><div class="main"><b>{{ editing.site }}</b><small>{{ editing.label }} · {{ used(editing) }}</small></div></div>
        <input v-model="edit.username" class="in" :placeholder="`아이디 (그대로 두려면 비워 두세요)`" autocomplete="off" />
        <input v-model="edit.password" class="in" type="password" placeholder="새 비밀번호" autocomplete="new-password" />
        <p class="hint">저장된 비밀번호는 보여주지 않아요. 새 값으로만 바꿀 수 있어요.</p>
        <p v-if="formError" class="ferr">{{ formError }}</p>
        <div class="fb"><span><span class="serif">process gpt</span>로 보호됨</span><button class="dark-btn" :disabled="!edit.password && !edit.username">변경</button></div>
      </form>
      <form v-if="page === 'accounts' && sub === 'key'" class="form glass" @submit.prevent="addKey">
        <input v-model="apiKey.site" class="in" placeholder="서비스 (예: api.openai.com)" />
        <input v-model="apiKey.key" class="in" type="password" placeholder="API 키" autocomplete="off" />
        <div class="fb"><span><span class="serif">process gpt</span>로 보호됨</span><button class="dark-btn" :disabled="!apiKey.site || !apiKey.key">저장</button></div>
      </form>

      <!-- wallet -->
      <template v-if="page === 'wallet' && !sub">
        <div v-if="cards.length" class="list glass">
          <div v-for="c in cards" :key="c.id" class="li">
            <span class="brand" :class="(c.meta?.brand || '').toLowerCase()">{{ c.meta?.brand || '카드' }}</span>
            <div class="main"><b>•••• {{ c.meta?.last4 || c.label.slice(-4) }}</b>
              <small v-if="c.status === 'captured'" class="warn">{{ statusText.captured }}</small>
              <small v-else>{{ new Date(c.created_at).toLocaleDateString('ko-KR') }} 저장 · {{ used(c) }}</small></div>
            <button v-if="c.status === 'captured'" class="pill-btn sm" @click="confirmVault(c)">저장</button>
            <button aria-label="삭제" @click="delVault(c)"><Icon name="trash" :size="20" /></button>
          </div>
        </div>
        <p v-else class="cap">저장된 카드가 없습니다.</p>
        <button class="pill-btn" @click="router.push('/settings/wallet/new')">새 카드 추가</button>
      </template>
      <template v-if="page === 'wallet' && sub === 'new'">
        <p class="cap">결제에 사용할 수 있는 신용카드를 추가하세요.</p>
        <form class="form glass" @submit.prevent="addCard">
          <input v-model="card.name" class="in" placeholder="성명" autocomplete="off" />
          <input :value="card.number" class="in" inputmode="numeric" placeholder="카드 번호" autocomplete="off" @input="fmtCard" />
          <div class="two">
            <input :value="card.exp" class="in" inputmode="numeric" placeholder="만료일(MM/YY)" @input="fmtExp" />
            <input v-model="card.cvv" class="in" inputmode="numeric" maxlength="4" type="password" placeholder="CVV" autocomplete="off" />
          </div>
          <input v-model="card.zip" class="in" placeholder="우편번호" />
          <p v-if="formError" class="ferr">{{ formError }}</p>
          <div class="fb"><span><span class="serif">process gpt</span>로 보호됨</span><button class="dark-btn" :disabled="card.number.length < 15 || !card.exp || !card.cvv">카드 추가</button></div>
        </form>
      </template>

      <!-- system -->
      <template v-if="page === 'system'">
        <div class="list glass">
          <div class="li"><div class="main"><b>테마</b><small>자동은 해가 지면 밤 테마로 바뀌어요</small></div>
            <div class="seg"><button v-for="(t, k) in { auto: '자동', light: '낮', dark: '밤' }" :key="k" :class="{ on: sky.themePref === k }" @click="sky.setTheme(k)">{{ t }}</button></div>
          </div>
          <div class="li col"><div class="main"><b>하늘 미리보기 · {{ simLabel }}</b><small>시간을 바꿔 하늘과 테마 전환을 확인해요</small></div>
            <input type="range" min="0" max="23.9" step="0.1" :value="sky.simHour ?? new Date().getHours()" @input="sky.setSim(Number($event.target.value))" />
            <button class="pill-btn" @click="sky.setSim(null)">실시간으로</button>
          </div>
          <div class="li"><div class="main"><b>메일 확인</b><small>새 메일을 주기적으로 읽고 할 일을 제안해요</small></div><button class="pill-btn" @click="pollMail">지금 확인</button></div>
          <div v-if="app.me?.mail?.provider === 'demo'" class="li col">
            <div class="main"><b>연습 메일 받기</b><small>데모 메일함에 가상의 거래처 메일이 도착해요</small></div>
            <DemoMailPractice />
          </div>
        </div>
      </template>

      <!-- security -->
      <template v-if="page === 'security'">
        <div class="list glass">
          <div class="li"><div class="main"><b>보관함 암호화</b><small>{{ cfg?.vault.algorithm }}</small></div></div>
          <div class="li"><div class="main"><b>마스터 키 (KEK)</b><small>{{ cfg?.vault.kekId }} · {{ cfg?.vault.provider === 'env' ? '환경 변수' : '서버 키링 파일' }} · {{ cfg?.vault.keyVersions }}개 버전. 데이터베이스에는 저장하지 않아요</small></div></div>
          <div class="li"><div class="main"><b>데이터 키 (DEK)</b><small>사용자마다 따로 만들고 KEK로 감싸서 저장해요. 항목은 이 키로 AES-256-GCM 암호화돼요</small></div></div>
          <div class="li"><div class="main"><b>비밀번호 노출</b><small>저장된 비밀번호·카드 번호·인증 코드는 화면과 AI 모델에 전달되지 않고, 브라우저 작업 때 서버가 직접 입력해요</small></div></div>
        </div>

        <p class="cap">암호화 검증</p>
        <div class="list glass">
          <div class="li"><div class="main"><b>내 보관함 검증</b><small>저장된 항목을 서버에서 열어 보고, 변조·이동에 대한 반응을 확인해요. 값은 보여주지 않아요</small></div>
            <button class="pill-btn sm" :disabled="checking" @click="runProof">{{ checking ? '확인 중' : '검증' }}</button></div>
          <template v-if="proof">
            <div class="li col">
              <div class="main"><b :class="proof.ok ? 'ok' : 'bad'">{{ proof.ok ? '모든 항목 통과' : '확인이 필요한 항목이 있어요' }}</b>
                <small>KEK {{ proof.kek.id }} → DEK v{{ proof.dek.version }} ({{ proof.dek.wrapped_bytes }}바이트로 감싸 저장, sha256 {{ proof.dek.wrapped_sha256 }})</small></div>
            </div>
            <div v-for="i in proof.items" :key="i.id" class="li col">
              <div class="main"><b>{{ i.kind === 'card' ? i.label : `${i.site} · ${i.label}` }}</b>
                <small>암호문 {{ i.ciphertext.bytes }}바이트 · sha256 {{ i.ciphertext.sha256 }} · 필드 {{ i.fields.join(', ') }}</small></div>
              <div class="checks"><span v-for="(v, k) in i.checks" :key="k" :class="v ? 'ok' : 'bad'">{{ v ? '✓' : '✗' }} {{ checkText[k] }}</span></div>
            </div>
          </template>
        </div>

        <p class="cap">보관함 활동</p>
        <div class="list glass">
          <div v-if="!audit.length" class="li"><div class="main"><small>아직 기록이 없어요</small></div></div>
          <div v-for="a in audit" :key="a.id" class="li">
            <div class="main"><b class="sm">{{ auditText(a) }}</b><small>{{ new Date(a.created_at).toLocaleString('ko-KR') }} · {{ actorText[a.actor] || a.actor }}</small></div>
          </div>
        </div>
      </template>

      <Teleport to="body"><MailConnect v-if="mailSheet" @close="mailClosed" /></Teleport>

      <template v-if="page === 'profile'">
        <div class="list glass">
          <div class="li"><div class="main"><b>이름</b><small>{{ app.me?.user?.name }}</small></div><button class="pill-btn sm" @click="router.push('/settings/accounts')">바꾸기</button></div>
          <div class="li"><div class="main"><b>이메일</b><small>{{ app.me?.user?.email }}</small></div></div>
          <div class="li"><div class="main"><b>생년월일</b><small>{{ app.me?.profile?.birth?.slice(0, 10) || '—' }}</small></div></div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.settings { position: absolute; inset: 0; z-index: 30; padding: 100px 16px 60px; }
.x { position: fixed; top: 14px; right: 16px; width: 48px; height: 48px; border-radius: 9999px; display: grid; place-items: center; background: var(--thin-bg); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px); z-index: 2; }
.home, .page { width: min(528px, 100%); margin: 0 auto; }
.home { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.avatar { width: 88px; height: 88px; border-radius: 9999px; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); color: #fff; display: grid; place-items: center; font-size: 36px; font-weight: 600; }
h2 { margin: 14px 0 0; font-size: 24px; font-weight: 600; }
.mail { margin: 0; color: var(--text-secondary); }
.plan { margin: 14px 0 22px; padding: 8px 16px; border-radius: 9999px; background: var(--cell-bg); }
.list { width: 100%; border-radius: 24px; padding: 4px 22px; margin-bottom: 14px; display: flex; flex-direction: column; }
.list > button { display: flex; justify-content: space-between; align-items: center; padding: 18px 0; font-size: 16px; border-bottom: 1px solid var(--hairline); text-align: left; }
.list > button:last-child, .li:last-child { border-bottom: 0; }
.danger { color: var(--color-error); }
.ph { display: flex; align-items: center; gap: 22px; margin-bottom: 26px; }
.back { width: 48px; height: 48px; border-radius: 9999px; display: grid; place-items: center; background: var(--thin-bg); }
h1 { margin: 0; font-size: 34px; font-weight: 500; letter-spacing: -0.02em; }
.cap { color: var(--text-secondary); font-size: 14px; margin: 0 0 18px; }
.li { display: flex; align-items: center; gap: 14px; padding: 18px 0; border-bottom: 1px solid var(--hairline); }
.li.col { flex-direction: column; align-items: stretch; gap: 10px; }
.li .main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.li b { font-weight: 450; font-size: 16px; }
.li small { color: var(--text-secondary); font-size: 14px; }
.li small.bad, b.bad, .checks .bad { color: var(--color-error); }
.li small.warn { color: #c25400; }
.li small.dim { color: var(--text-tertiary); }
.li button.main { text-align: left; }
.li.flat { padding: 0 0 6px; border: 0; }
b.ok, .checks .ok { color: #1f8a4c; }
b.sm { font-size: 15px; }
.checks { display: flex; flex-wrap: wrap; gap: 6px 12px; font-size: 13px; }
.pill-btn.sm { height: 34px; padding: 0 14px; font-size: 14px; }
.brand { min-width: 64px; height: 40px; border-radius: 8px; display: grid; place-items: center; font-size: 12px; font-weight: 600; color: #fff; background: #5b6170; }
.brand.visa { background: #1a1f71; } .brand.mastercard { background: #eb001b; } .brand.amex { background: #2e77bc; } .brand.jcb { background: #0b7a3e; }
.ferr { margin: 0; color: var(--color-error); font-size: 14px; }
.hint { margin: 0; color: var(--text-secondary); font-size: 13px; }
.fav { width: 22px; height: 22px; border-radius: 6px; }
.fav.mailic { display: grid; place-items: center; color: var(--text-secondary); }
.nm { width: 40%; min-width: 110px; height: 36px; border-radius: 10px; padding: 0 10px; border: 1px solid var(--hairline); background: var(--cell-bg); color: var(--text-primary); font-size: 15px; }
.msel { height: 36px; border-radius: 10px; padding: 0 10px; font-size: 14px; border: 1px solid var(--hairline); background: var(--cell-bg, transparent); color: var(--text-primary); max-width: 46%; }
.tag { font-size: 12px; color: var(--text-secondary); background: var(--cell-bg); padding: 3px 8px; border-radius: 9999px; }
.tabs { display: flex; gap: 6px; margin: 4px 0 14px; }
.tabs button { height: 34px; padding: 0 14px; border-radius: 9999px; font-size: 14px; color: var(--text-secondary); background: var(--thin-bg); }
.tabs button.on { background: var(--ink); color: var(--ink-inverse); }
.row2 { display: flex; gap: 8px; }
.form { border-radius: 24px; padding: 28px; display: flex; flex-direction: column; gap: 12px; }
.in { width: 100%; height: 48px; border-radius: 9999px; border: 0; outline: 0; padding: 0 22px; background: var(--cell-bg); font-size: 16px; }
.in::placeholder { color: var(--text-tertiary); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.fb { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; font-size: 15px; color: var(--text-secondary); }
.fb .serif { color: var(--text-primary); font-weight: 500; }
.fb .dark-btn { border-radius: 14px; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
.seg { display: flex; padding: 2px; border-radius: 9999px; background: var(--cell-bg); }
.seg button { height: 32px; padding: 0 14px; border-radius: 9999px; font-size: 14px; color: var(--text-secondary); }
.seg button.on { background: var(--ink); color: var(--ink-inverse); }
input[type=range] { width: 100%; accent-color: var(--text-primary); }
</style>
