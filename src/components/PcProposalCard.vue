<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import Icon from './Icon.vue'
import FIcon from './folders/FIcon.vue'
import { api } from '../api.js'
import { GROUP, reasonText, fmtBytes, PLATFORM, KIND, whyText } from '../desktopFolders.js'

// 「스킬을 등록할까요?」 · 「폴더를 올릴까요?」 — the person's own CLI on their PC proposed a skill or a folder of that PC (server
// lib/localAgents/pcTools.js · desktop runner/tools.js). Nothing is registered or uploaded until they press 「등록」 · 「올리기」 here: the card
// shows everything first (what goes up, what was left out and why, run settings, where it goes), drawn from the server's view, and the
// press brings back that view's confirmation. A skill goes to 「내 스킬」, or 「회사 스킬」 — the rule of the skill folder's 「전사에 공유」:
// its author may (with run settings: one more check). A folder is uploaded by that PC's app with the champion folders' own engine; the card follows it to 「올렸어요 · 열기」.
const props = defineProps({ msg: Object })
const router = useRouter()
const pc = computed(() => props.msg.content?.pc || {})
const view = ref(null)
const busy = ref('')
const err = ref('')
// (「내 스킬」 first, whatever the CLI asked for: 「회사 스킬」 is the person's own choice, and always checked once more)
const scope = ref('mine')
const companyOk = ref(false)
const name = ref('')
const showFiles = ref(false)
const open = ref(new Set())

async function load() {
  try {
    view.value = await api(`/pc-proposals/${encodeURIComponent(pc.value.id)}`)
    err.value = ''
    if (!name.value) name.value = view.value.name || ''
  } catch (e) { err.value = e.message }
}
onMounted(load)
// (the card changed on the server — a press, its result, the hour ran out: read again)
watch(() => JSON.stringify([pc.value.state, pc.value.result, pc.value.error]), load)

const v = computed(() => view.value || {})
const state = computed(() => v.value.state || pc.value.state || 'pending')
const skill = computed(() => (v.value.kind || pc.value.kind) === 'skill')
const runs = computed(() => [...(v.value.runs || []), ...(v.value.runFiles || [])])
const canCompany = computed(() => !!v.value.options?.company)
const WHERE = { claude: 'Claude Code 의 내 스킬', codex: 'Codex 의 스킬', agents: '에이전트 스킬 폴더', work: '이 대화의 작업 폴더', other: '이 PC 의 폴더' }
const left = computed(() => (v.value.excluded || []).filter((g) => g.count > 0))
const pv = computed(() => v.value.preview || {})
const flagged = computed(() => pv.value.flagged || [])
const pvLeft = computed(() => (pv.value.excluded || []).filter((g) => g.count > 0))
const kitLines = computed(() => {
  const m = new Map()
  for (const k of pv.value.kit || []) {
    if (!m.has(k.platform)) m.set(k.platform, {})
    m.get(k.platform)[k.type] = (m.get(k.platform)[k.type] || 0) + 1
  }
  return [...m.entries()].map(([p, c]) => ({ platform: p, label: PLATFORM[p] || p, line: Object.keys(KIND).filter((t) => c[t]).map((t) => `${KIND[t]} ${c[t]}`).join(' · ') }))
})
const minutesLeft = computed(() => (v.value.expiresAt ? Math.max(0, Math.round((new Date(v.value.expiresAt).getTime() - Date.now()) / 60000)) : null))
const blocked = computed(() => !view.value || !v.value.confirm || !!busy.value || !name.value.trim()
  || (skill.value && scope.value === 'company' && !companyOk.value))
const ERR = { pc_offline: '이 폴더가 있는 PC 의 앱이 꺼져 있어요 — 켜고 다시 눌러 주세요', no_pick: 'PC 앱이 다시 켜져서 제안이 만료됐어요 — 채팅에서 다시 부탁해 주세요',
  changed: '미리 보여 드린 뒤 폴더가 바뀌었어요(파일이 추가·삭제·수정되었거나 다른 파일로 바뀌었어요). 아무것도 올리지 않았어요. 채팅에서 다시 제안해 달라고 요청해 주세요.',
  create_failed: '공유 폴더를 만들지 못했어요. 잠시 뒤 다시 눌러 주세요.' }
const errorText = (e) => (e ? ERR[e] || whyText(e) || e : '')
const toggle = (g) => { const s = new Set(open.value); s.has(g) ? s.delete(g) : s.add(g); open.value = s }

async function act(what, body) {
  busy.value = what
  err.value = ''
  try {
    view.value = await api(`/pc-proposals/${encodeURIComponent(pc.value.id)}/${what}`, { method: 'POST', ...(body ? { body } : {}) })
  } catch (e) {
    err.value = e.message
    if (['stale', 'expired', 'already', 'closed', 'name_taken'].includes(e.code)) load()
  } finally { busy.value = '' }
}
const register = () => act('register', { scope: scope.value || 'mine', companyOk: scope.value === 'company' && companyOk.value, name: name.value.trim(), confirm: v.value.confirm })
const upload = () => act('upload', { name: name.value.trim(), confirm: v.value.confirm })
const openIt = () => { const slug = v.value.result?.slug || pc.value.result?.slug; if (slug) router.push(`/folders/${encodeURIComponent(slug)}`) }
</script>

<template>
  <!-- registered · uploaded -->
  <div v-if="state === 'done'" class="pp done glass" data-test="pc-proposal" :data-kind="skill ? 'skill' : 'folder'" data-state="done">
    <Icon name="check" :size="18" />
    <div class="txt">
      <b data-test="pc-proposal-state">{{ skill ? '스킬을 등록했어요' : '폴더를 올렸어요' }}</b>
      <small><span data-no-i18n>「{{ v.result?.name || v.name || pc.name }}」</span> ·
        {{ skill ? (v.result?.visibility === 'tenant' ? '회사 스킬 — 회사 사람들의 에이전트도 써요' : '내 스킬 — 나와 내 에이전트만 써요') : `파일 ${(v.result?.pushed?.files ?? pv.files ?? 0).toLocaleString()}개` }}</small>
      <small v-if="v.result?.shareError" class="warn" data-test="pc-proposal-share-error">회사 스킬로 등록하지 못해 내 스킬로 두었어요 — 스킬 폴더에서 다시 공유해 주세요</small>
    </div>
    <button class="open press" data-test="pc-proposal-open" @click="openIt">열기 <Icon name="chevron" :size="14" /></button>
  </div>
  <!-- dropped · expired -->
  <div v-else-if="state === 'dropped' || state === 'expired'" class="pp gone" data-test="pc-proposal" :data-state="state">
    <FIcon :name="skill ? 'kit' : 'pc'" :size="15" />
    <span data-test="pc-proposal-state">{{ state === 'dropped' ? (skill ? '등록하지 않기로 했어요' : '올리지 않기로 했어요') : '한 시간이 지나 제안이 만료됐어요 — 채팅에서 다시 부탁해 주세요' }}</span>
    · <span data-no-i18n>{{ v.name || pc.name }}</span>
  </div>
  <!-- failed -->
  <div v-else-if="state === 'failed'" class="pp glass" data-test="pc-proposal" :data-kind="skill ? 'skill' : 'folder'" data-state="failed">
    <div class="h"><Icon name="alert" :size="17" /><b data-test="pc-proposal-state">{{ skill ? '스킬을 등록하지 못했어요' : '폴더를 올리지 못했어요' }}</b><span class="sub" data-no-i18n>{{ v.name || pc.name }}</span></div>
    <p class="notice">{{ errorText(v.error || pc.error) }}</p>
  </div>
  <!-- pending · working: everything that goes up, before the press -->
  <div v-else class="pp glass" data-test="pc-proposal" :data-kind="skill ? 'skill' : 'folder'" :data-state="state">
    <div class="h">
      <FIcon :name="skill ? 'kit' : 'pc'" :size="17" />
      <b>{{ skill ? '스킬을 등록할까요?' : '폴더를 올릴까요?' }}</b>
      <span class="badge" data-test="pc-proposal-gate">{{ state === 'working' ? (skill ? '등록하고 있어요…' : 'PC 앱이 올리고 있어요…') : skill ? '「등록」을 눌러야 등록돼요' : '「올리기」를 눌러야 올라가요' }}</span>
    </div>
    <p class="from">
      <template v-if="skill">내 PC · {{ WHERE[v.source?.where] || WHERE.other }} · <span data-no-i18n>{{ v.source?.label }}</span></template>
      <template v-else>내 PC<template v-if="v.device"> · <span data-no-i18n>{{ v.device }}</span></template> · 폴더 <span data-no-i18n>「{{ v.label }}」</span></template>
    </p>

    <!-- a skill -->
    <template v-if="skill">
      <p v-if="v.description" class="desc" data-test="pc-proposal-desc" data-no-i18n>{{ v.description }}</p>
      <div class="sum" data-test="pc-proposal-total"><b>파일 {{ (v.files || 0).toLocaleString() }}개</b><span>{{ fmtBytes(v.bytes) }}</span>
        <button v-if="(v.list || []).length" class="more press" @click="showFiles = !showFiles">{{ showFiles ? '접기' : '파일 보기' }}</button></div>
      <ul v-if="showFiles" class="files" data-test="pc-proposal-files">
        <li v-for="f in v.list" :key="f.path"><span data-no-i18n>{{ f.path }}</span><small>{{ fmtBytes(f.size) }}</small></li>
        <li v-if="v.more" class="more-n">외 {{ v.more }}개</li>
      </ul>
      <div v-if="left.length || v.flagged" class="left" data-test="pc-proposal-left">
        <span class="lab">뺀 것</span>
        <span v-for="g in left" :key="g.group" class="chip">{{ GROUP[g.group] || g.group }} {{ g.count }}</span>
        <span v-if="v.flagged" class="chip">확인이 필요한 파일 {{ v.flagged }}</span>
      </div>
      <p v-if="runs.length" class="runs" data-test="pc-proposal-runs"><Icon name="alert" :size="14" />
        <span>실행 설정이 있어요(<span data-no-i18n>{{ runs.join(' · ') }}</span>) — 이 스킬을 쓰는 사람의 PC 에서 자동 명령이 실행되거나 확인 없이 도구가 사용돼요</span></p>
      <div v-if="state === 'pending'" class="where" role="radiogroup" aria-label="어디에 등록할까요">
        <span class="lab">어디에</span>
        <label class="opt" data-test="pc-proposal-scope" data-scope="mine"><input v-model="scope" type="radio" value="mine" /> <b>내 스킬</b><small>나와 내 에이전트만 써요</small></label>
        <label v-if="canCompany" class="opt" data-test="pc-proposal-scope" data-scope="company"><input v-model="scope" type="radio" value="company" /> <b>회사 스킬</b><small>회사 사람들의 에이전트도 써요</small></label>
      </div>
      <label v-if="state === 'pending' && scope === 'company'" class="again" data-test="pc-proposal-company-ok" :data-runs="runs.length ? 'yes' : 'no'">
        <input v-model="companyOk" type="checkbox" /> {{ runs.length ? '실행 설정이 회사 사람들의 PC에 적용된다는 점을 이해하고 등록해요' : '회사 사람들의 에이전트가 이 스킬을 사용하게 된다는 점을 확인했어요' }}</label>
      <p v-if="state === 'pending'" class="hint" data-test="pc-proposal-staged">이 스킬 파일은 지금 서버의 임시 공간에 있어요. 등록하지 않으면 한 시간이 지난 뒤 지워져요.</p>
    </template>

    <!-- a folder: the champion folders' preview -->
    <template v-else>
      <div class="sum" data-test="pc-proposal-total"><b>파일 {{ (pv.files || 0).toLocaleString() }}개</b><span>{{ fmtBytes(pv.bytes) }}</span></div>
      <ul v-if="(pv.top || []).length" class="files" data-test="pc-proposal-top">
        <li v-for="t in (pv.top || []).slice(0, 8)" :key="t.path"><span data-no-i18n>{{ t.path }}</span><small>파일 {{ t.files.toLocaleString() }}개 · {{ fmtBytes(t.bytes) }}</small></li>
        <li v-if="(pv.top || []).length > 8" class="more-n">외 {{ pv.top.length - 8 }}개</li>
      </ul>
      <div v-if="flagged.length" class="flags" data-test="pc-proposal-flagged">
        <span class="lab warnc">확인이 필요한 파일 {{ flagged.length }}개는 빼고 올려요</span>
        <small v-for="f in flagged.slice(0, 5)" :key="f.path"><span data-no-i18n>{{ f.path }}</span>{{ f.line ? ` · ${f.line}째 줄` : '' }} · {{ reasonText(f.reason) }}</small>
      </div>
      <div v-for="g in pvLeft" :key="g.group" class="grp" data-test="pc-proposal-excluded" :data-group="g.group">
        <button class="gh press" @click="toggle(g.group)"><span class="tw">{{ open.has(g.group) ? '▾' : '▸' }}</span><span class="gn">{{ GROUP[g.group] || g.group }}</span><span class="cnt">{{ g.count.toLocaleString() }}</span></button>
        <div v-if="open.has(g.group)" class="samples"><small v-for="s in g.samples || []" :key="s" data-no-i18n>{{ s }}</small><small v-if="(g.samples || []).length < g.count">외 {{ (g.count - (g.samples || []).length).toLocaleString() }}개</small></div>
      </div>
      <div v-if="kitLines.length" class="kits" data-test="pc-proposal-kit">
        <span class="lab">찾은 에이전트 자산</span>
        <span v-for="k in kitLines" :key="k.platform" class="chip"><b>{{ k.label }}</b> {{ k.line }}</span>
      </div>
      <p v-if="state === 'pending'" class="hint">처음에는 나만 볼 수 있어요. 올린 뒤 폴더의 「공유」에서 동료를 초대해 주세요. 내 PC 의 폴더는 그대로예요. 변경한 내용은 폴더 화면의 「지금 올리기」를 눌러 올려 주세요.</p>
      <p v-if="state === 'pending' && v.pcOnline === false" class="notice" data-test="pc-proposal-offline">이 폴더가 있는 PC 의 앱이 꺼져 있어요 — 켜야 올라가요</p>
    </template>

    <label v-if="state === 'pending'" class="nm"><span class="lab">이름</span>
      <input v-model="name" maxlength="80" data-test="pc-proposal-name" :placeholder="skill ? '스킬 이름' : '폴더 이름'" /></label>
    <p v-if="state === 'pending' && v.nameTaken && name.trim() === v.name" class="notice" data-test="pc-proposal-taken">{{ skill ? '같은 이름의 스킬이 이미 있어요 — 다른 이름을 적어 주세요' : '같은 이름의 폴더가 이미 있어요 — 다른 이름을 적어 주세요' }}</p>
    <p v-if="v.error && state === 'pending'" class="notice" data-test="pc-proposal-last">{{ errorText(v.error) }}</p>
    <p v-if="err" class="err" data-test="pc-proposal-err">{{ err }}</p>
    <div v-if="state === 'pending'" class="row">
      <small v-if="minutesLeft != null" class="ttl">{{ minutesLeft }}분 뒤에 사라져요</small>
      <button class="pill-btn sm ghost" :disabled="!!busy" data-test="pc-proposal-drop" @click="act('drop')">그만두기</button>
      <button class="dark-btn sm" :disabled="blocked" data-test="pc-proposal-go" @click="skill ? register() : upload()">
        {{ busy === 'register' ? '등록하고 있어요…' : busy === 'upload' ? '보내는 중…' : skill ? '등록' : '올리기' }}</button>
    </div>
  </div>
</template>

<style scoped>
.pp { width: 460px; max-width: 100%; box-sizing: border-box; border-radius: 22px; padding: 16px 16px 12px; display: flex; flex-direction: column; gap: 6px; --regular-bg: var(--bubble-agent-bg); }
.h { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 15px; }
.h .sub { color: var(--text-secondary); font-size: 13.5px; overflow-wrap: anywhere; }
.badge { margin-left: auto; font-size: 12px; color: var(--text-secondary); background: var(--chip-bg); border-radius: 9999px; padding: 3px 10px; }
.from { margin: 0; font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
.desc { margin: 2px 0 0; font-size: 14px; line-height: 1.55; overflow-wrap: anywhere; }
.sum { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 14px; background: var(--cell-bg); margin-top: 4px; }
.sum b { font-size: 18px; font-weight: 600; } .sum span { color: var(--text-secondary); font-size: 14px; }
.more { margin-left: auto; font-size: 13px; color: var(--color-info); }
.files { list-style: none; margin: 0; padding: 4px 2px; display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.files li { display: flex; justify-content: space-between; gap: 10px; font-size: 12.5px; font-family: "SF Mono", Menlo, monospace; min-width: 0; }
.files li span { overflow-wrap: anywhere; min-width: 0; } .files li small { color: var(--text-tertiary); flex: none; font-family: inherit; }
.more-n { color: var(--text-tertiary); }
.lab { font-size: 12.5px; color: var(--text-secondary); flex: none; }
.left, .kits { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 2px; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 12.5px; padding: 3px 10px; border-radius: 9999px; background: var(--field-bg); max-width: 100%; overflow-wrap: anywhere; }
.chip b { font-weight: 600; }
.runs { display: flex; gap: 6px; align-items: flex-start; margin: 4px 0 0; font-size: 13px; color: #c2410c; line-height: 1.5; overflow-wrap: anywhere; }
.where { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
.opt { display: flex; align-items: baseline; gap: 8px; font-size: 14px; padding: 6px 10px; border-radius: 12px; background: var(--cell-bg); cursor: pointer; flex-wrap: wrap; }
.opt b { font-weight: 600; } .opt small { color: var(--text-secondary); font-size: 12.5px; }
.again { display: flex; gap: 8px; align-items: flex-start; font-size: 13px; color: #c2410c; margin-top: 2px; line-height: 1.5; }
.flags { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 12px; background: rgba(255 160 60 / .1); }
.flags small { font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.warnc { color: #c2410c; }
.grp { border: 1px solid var(--hairline); border-radius: 12px; overflow: hidden; }
.gh { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 10px; font-size: 13px; text-align: left; }
.gn { flex: 1; min-width: 0; } .tw { width: 12px; color: var(--text-tertiary); font-size: 11px; }
.cnt { min-width: 20px; padding: 0 7px; border-radius: 10px; background: var(--button-bg); font-size: 11.5px; color: var(--text-secondary); text-align: center; }
.samples { display: flex; flex-direction: column; gap: 2px; padding: 0 10px 8px 30px; }
.samples small { font-family: "SF Mono", Menlo, monospace; font-size: 12px; color: var(--text-secondary); overflow-wrap: anywhere; }
.nm { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--hairline); padding: 6px 0; margin-top: 4px; }
.nm input { flex: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 14px; color: var(--text-primary); padding: 4px 0; outline: none; }
.hint { margin: 4px 0 0; font-size: 12.5px; color: var(--text-secondary); line-height: 1.55; word-break: keep-all; }
.notice { margin: 4px 0 0; font-size: 13.5px; color: #c2410c; overflow-wrap: anywhere; }
.err { margin: 4px 0 0; font-size: 13px; color: #c2410c; overflow-wrap: anywhere; }
.warn { color: #c2410c; }
.row { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.ttl { margin-right: auto; font-size: 12px; color: var(--text-tertiary); }
.sm { height: 40px; padding: 0 16px; }
.ghost { background: transparent; }
.pill-btn:disabled, .dark-btn:disabled { opacity: .5; }
:root[data-theme="dark"] .dark-btn { background: #f5f5f7; color: #1d1d1f; }
:root[data-theme="dark"] .runs, :root[data-theme="dark"] .again, :root[data-theme="dark"] .notice, :root[data-theme="dark"] .warnc, :root[data-theme="dark"] .warn { color: #ffb870; }
.done { flex-direction: row; align-items: flex-start; gap: 10px; }
.done .txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.done small { color: var(--text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.open { flex: none; display: inline-flex; align-items: center; gap: 2px; height: 34px; padding: 0 12px; border-radius: 17px; background: var(--button-bg); font-size: 13.5px; font-weight: 500; }
.gone { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); padding: 6px 12px; border-radius: 9999px; background: var(--chip-bg); max-width: 100%; overflow-wrap: anywhere; flex-wrap: wrap; }
@media (max-width: 520px) {
  .pp { width: 100%; }
  .row > button { flex: 1; }
  .ttl { flex-basis: 100%; }
}
</style>
