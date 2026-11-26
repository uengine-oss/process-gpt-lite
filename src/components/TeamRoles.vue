<script setup>
// Settings → 팀·역할: who is on the team and who plays which process role. A process step goes
// to the teammate holding its role (nobody → the person who started it), and that person is
// the one notified.
// Invite-only (2026-11-25, server lib/membership.js): only people an administrator invited, or approved, come into the company. An
// administrator here 「초대」s addresses (Process GPT's invite: the account, the row and the mail), approves or declines the 「가입 요청」
// (people who signed in without an invitation), and 「내보내기」s a member (their membership ends — not oneself, not the company's owner,
// not the last administrator: the server says which, `removable`).
import { ref, computed, onMounted, watch } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'
import PersonAvatar from './PersonAvatar.vue'
// two of the same name on the team (one person's two accounts, or two people) are told apart by their address (src/sameNames.js)
import { tagsFor, labelOf } from '../people.js'

const app = useApp()
// the team and the tenant-wide role holders are changed by administrators (server: 403 otherwise)
const admin = computed(() => !!app.me?.admin)
const team = ref([])
const roles = ref([])
const held = ref({})
// a process's own holder of a role (정식 등록 writes the person who did the step before): it wins over
// the tenant-wide holder above, so it is shown under the role and changed there — otherwise picking
// someone above would look done while that process kept sending the step to the old holder
const own = ref([])
const tags = computed(() => tagsFor(team.value))
const invite = ref({ emails: '', admin: false })
const sent = ref([])
const busy = ref(false)
const requests = ref([])
const leaving = ref(null) // the member whose 「내보내기」 waits for its confirmation
const err = ref('')
const find = ref('')
// roles someone already holds first, then by how many processes use them
const shown = computed(() => {
  const k = find.value.trim()
  return roles.value.filter((r) => !k || r.role.includes(k) || r.processes.some((p) => p.includes(k)))
    .sort((a, b) => !!held.value[b.role] - !!held.value[a.role])
})

// the people waiting (an administrator's): on their own, so the team list never waits for them
async function loadRequests() {
  if (admin.value) requests.value = await api('/team/requests').catch(() => requests.value)
}
async function load() {
  loadRequests()
  const [t, c, a] = await Promise.all([api('/team'), api('/roles/catalog'), api('/roles')])
  team.value = t
  roles.value = c
  held.value = Object.fromEntries(a.filter((x) => x.proc_def_id === '*').map((x) => [x.role, x.user_id]))
  own.value = a.filter((x) => x.proc_def_id !== '*')
}
const key = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase()
const ownOf = (r) => own.value.filter((x) => key(x.role) === key(r.role) && r.defs?.[x.proc_def_id])
  .map((x) => ({ ...x, defName: r.defs[x.proc_def_id] }))
onMounted(load)
// (who I am can come after the screen: the requests are an administrator's)
watch(admin, (yes, was) => { if (yes && !was) loadRequests() })

// 「초대 보내기」: one or more addresses (commas, spaces or lines between them) → what became of each
const SAID = { invited: '초대했어요', approved: '승인했어요', member: '이미 구성원이에요', invalid: '주소를 확인해 주세요', failed: '초대하지 못했어요' }
async function sendInvites() {
  err.value = ''
  busy.value = true
  try {
    sent.value = await api('/team/invites', { method: 'POST', body: { emails: invite.value.emails, admin: invite.value.admin } })
    invite.value = { emails: '', admin: false }
    await load()
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
async function decide(r, how) {
  err.value = ''
  try { await api(`/team/requests/${r.id}/${how}`, { method: 'POST' }) } catch (e) { err.value = e.message }
  await load()
}
async function remove(m) {
  err.value = ''
  try { await api(`/team/members/${m.id}/remove`, { method: 'POST' }) } catch (e) { err.value = e.message }
  leaving.value = null
  await load()
}
// '' = this process follows the role's holder above (its own assignment is removed)
async function setOwn(x, userId) {
  err.value = ''
  try { await api('/roles', { method: 'PUT', body: { defId: x.proc_def_id, role: x.role, userId: userId || null } }) } catch (e) { err.value = e.message }
  await load()
}
async function setRole(role, userId) {
  err.value = ''
  const was = held.value[role]
  held.value[role] = userId
  try { await api('/roles', { method: 'PUT', body: { role, userId: userId || null } }) } catch (e) { held.value[role] = was; err.value = e.message }
}
</script>

<template>
  <div class="tr">
    <p class="cap">팀원</p>
    <div class="list glass" data-test="team-members">
      <template v-for="m in team" :key="m.id">
        <div class="li" :data-member="m.email">
          <PersonAvatar :id="m.id" :name="m.name || m.email" />
          <div class="main"><b>{{ labelOf(tags, m) }}<span v-if="m.id === app.me?.user?.id" class="me"> · 나</span><span v-if="m.admin" class="role">관리자</span></b><small>{{ m.email }}</small></div>
          <button v-if="admin && m.removable && leaving !== m.id" class="rm" data-test="member-remove" @click="leaving = m.id">내보내기</button>
        </div>
        <div v-if="leaving === m.id" class="li confirm" data-test="member-remove-confirm">
          <p>내보내면 이 회사에 들어올 수 없어요. 다시 초대하면 돌아올 수 있어요.</p>
          <div class="acts"><button class="pill-btn sm" @click="leaving = null">취소</button><button class="pill-btn sm danger" @click="remove(m)">내보내기</button></div>
        </div>
      </template>
    </div>

    <template v-if="admin">
      <p class="cap">초대</p>
      <div class="invite glass">
        <p class="note">초대한 사람만 이 회사에 들어올 수 있어요. 초대 메일이 가고, 그 주소로 로그인하면 바로 들어와요.</p>
        <form class="add" data-test="invite-form" @submit.prevent="sendInvites">
          <textarea v-model="invite.emails" rows="2" placeholder="이메일 주소 (여러 명은 쉼표로 구분)" aria-label="초대할 이메일 주소" />
          <div class="row">
            <select v-model="invite.admin" aria-label="초대할 역할">
              <option :value="false">구성원으로</option>
              <option :value="true">관리자로</option>
            </select>
            <button class="dark-btn send" :disabled="busy || !invite.emails.trim()">초대 보내기</button>
          </div>
        </form>
        <ul v-if="sent.length" class="sent" data-test="invite-results">
          <li v-for="s in sent" :key="s.email" :data-result="s.result"><span>{{ s.email }}</span><small>{{ SAID[s.result] || s.result }}<template v-if="s.result === 'invited' && !s.mailed"> · 메일은 보내지 못했어요 — 주소로 로그인하라고 알려 주세요</template></small></li>
        </ul>
      </div>

      <p class="cap">가입 요청<span v-if="requests.length" class="count">{{ requests.length }}</span></p>
      <div class="list glass" data-test="join-requests">
        <div v-for="r in requests" :key="r.id" class="li" :data-request="r.email">
          <PersonAvatar :id="r.id" :name="r.name || r.email" />
          <div class="main"><b>{{ r.name || r.email }}</b><small>{{ r.email }}</small></div>
          <div class="acts">
            <button class="pill-btn sm" data-test="request-reject" @click="decide(r, 'reject')">거절</button>
            <button class="pill-btn sm ok" data-test="request-approve" @click="decide(r, 'approve')">승인</button>
          </div>
        </div>
        <p v-if="!requests.length" class="empty">기다리는 요청이 없어요.</p>
      </div>
    </template>
    <p v-else class="hint ro">초대·내보내기와 역할 담당 지정은 관리자만 할 수 있어요. 바꿀 일이 있으면 관리자에게 알려 주세요.</p>
    <p v-if="err" class="err">{{ err }}</p>

    <p class="cap">역할 담당</p>
    <p class="hint">프로세스 단계는 그 역할을 맡은 팀원에게 가고, 그 사람에게 알림이 갑니다. 비워 두면 일을 시작한 사람(예약을 건 사람)이 맡습니다.</p>
    <input v-model="find" class="find" placeholder="역할·프로세스 검색" />
    <div class="list glass">
      <template v-for="r in shown" :key="r.role">
        <div class="li">
          <div class="main"><b>{{ r.role }}</b><small>{{ r.processes.join(' · ') }}</small></div>
          <select :value="held[r.role] || ''" :disabled="!admin" :title="admin ? '' : '관리자만 바꿀 수 있어요'" @change="setRole(r.role, $event.target.value)">
            <option value="">시작한 사람</option>
            <option v-for="m in team" :key="m.id" :value="m.id">{{ labelOf(tags, m) }}</option>
          </select>
        </div>
        <div v-for="x in ownOf(r)" :key="r.role + x.proc_def_id" class="li sub">
          <div class="main"><small>↳ {{ x.defName }}</small></div>
          <select :value="x.user_id" :disabled="!admin" :aria-label="`${x.defName} ${r.role}`" @change="setOwn(x, $event.target.value)">
            <option value="">위 담당 따름</option>
            <option v-for="m in team" :key="m.id" :value="m.id">{{ labelOf(tags, m) }}</option>
          </select>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.cap { margin: 18px 4px 8px; color: var(--text-secondary); font-size: 14px; }
.hint { margin: -2px 4px 10px; color: var(--text-tertiary); font-size: 13px; line-height: 1.5; }
.list { border-radius: 20px; overflow: hidden; }
.li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.li:last-child { border-bottom: 0; }
.li.sub { padding: 8px 14px 10px 28px; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; text-align: left; }
.main b { font-weight: 500; font-size: 15px; }
.main small { color: var(--text-secondary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me { color: var(--text-tertiary); font-weight: 400; }
.rm { color: var(--text-secondary); font-size: 13px; flex: none; }
.role { margin-left: 6px; padding: 1px 7px; border-radius: 9999px; background: var(--button-bg); color: var(--text-secondary); font-size: 11px; font-weight: 500; vertical-align: 1px; }
.count { margin-left: 6px; padding: 0 7px; border-radius: 9999px; background: var(--color-attention); color: #fff; font-size: 12px; }
.confirm { flex-direction: column; align-items: stretch; gap: 8px; background: var(--button-bg); }
.confirm p { margin: 0; font-size: 13px; line-height: 1.5; color: var(--text-secondary); text-align: left; }
.acts { display: flex; gap: 6px; justify-content: flex-end; flex: none; }
.pill-btn.sm { height: 32px; padding: 0 14px; font-size: 13px; }
.pill-btn.ok { color: var(--text-primary); font-weight: 600; }
.pill-btn.danger { color: var(--color-error); }
.empty { margin: 0; padding: 14px; color: var(--text-tertiary); font-size: 13px; }
.sent { list-style: none; margin: 10px 0 0; padding: 10px 0 0; border-top: 1px solid var(--hairline); display: flex; flex-direction: column; gap: 4px; }
.sent li { display: flex; flex-wrap: wrap; gap: 2px 8px; font-size: 13px; padding: 0 4px; }
.sent li span { color: var(--text-primary); overflow-wrap: anywhere; }
.sent li small { color: var(--text-secondary); }
.sent li[data-result="invalid"] small, .sent li[data-result="failed"] small { color: var(--color-error); }
select { max-width: 46%; height: 34px; border-radius: 10px; padding: 0 8px; background: rgba(255, 255, 255, .7); border: 1px solid rgba(0, 0, 0, .1); font-size: 14px; }
.invite { border-radius: 20px; padding: 12px 14px 14px; }
.invite .note { margin: 0 0 10px; font-size: 13px; line-height: 1.5; color: var(--text-secondary); text-align: left; }
.add { display: flex; flex-direction: column; gap: 8px; }
.add textarea { width: 100%; min-height: 64px; resize: vertical; border-radius: 12px; padding: 10px 12px; border: 1px solid var(--hairline); background: var(--field-bg);
  font: inherit; font-size: 14px; color: var(--text-primary); }
.add textarea::placeholder { color: var(--text-tertiary); }
.add .row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.add select { max-width: none; background: var(--field-bg); border-color: var(--hairline); color: var(--text-primary); }
.add .send { height: 34px; padding: 0 16px; font-size: 14px; }
:root[data-theme="dark"] .add .send { background: #f5f5f7; color: #1d1d1f; }
.find { width: 100%; height: 38px; border-radius: 12px; padding: 0 12px; margin-bottom: 8px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .7); }
.err { color: #c62828; font-size: 13px; margin: 6px 4px; }
.hint.ro { margin-top: 10px; }
select:disabled { opacity: .7; }
</style>
