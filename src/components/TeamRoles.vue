<script setup>
// Settings → 팀·역할: who is on the team and who plays which process role. A process step goes
// to the teammate holding its role (nobody → the person who started it), and that person is
// the one notified.
import { ref, computed, onMounted } from 'vue'
import { api } from '../api.js'
import { useApp } from '../stores/app.js'

const app = useApp()
// the team and the tenant-wide role holders are changed by administrators (server: 403 otherwise)
const admin = computed(() => !!app.me?.admin)
const team = ref([])
const roles = ref([])
const held = ref({})
const add = ref({ name: '', email: '' })
const err = ref('')
const find = ref('')
// roles someone already holds first, then by how many processes use them
const shown = computed(() => {
  const k = find.value.trim()
  return roles.value.filter((r) => !k || r.role.includes(k) || r.processes.some((p) => p.includes(k)))
    .sort((a, b) => !!held.value[b.role] - !!held.value[a.role])
})

async function load() {
  const [t, c, a] = await Promise.all([api('/team'), api('/roles/catalog'), api('/roles')])
  team.value = t
  roles.value = c
  held.value = Object.fromEntries(a.filter((x) => x.proc_def_id === '*').map((x) => [x.role, x.user_id]))
}
onMounted(load)

async function addMember() {
  err.value = ''
  try {
    await api('/team', { method: 'POST', body: add.value })
    add.value = { name: '', email: '' }
    await load()
  } catch (e) { err.value = e.status === 403 ? e.message : '이메일을 확인해 주세요.' }
}
async function remove(m) {
  err.value = ''
  try { await api(`/team/${m.id}`, { method: 'DELETE' }) } catch (e) { err.value = e.message }
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
    <div class="list glass">
      <div v-for="m in team" :key="m.id" class="li">
        <div class="av">{{ (m.name || m.email).slice(0, 1) }}</div>
        <div class="main"><b>{{ m.name }}<span v-if="m.id === app.me?.user?.id" class="me"> · 나</span></b><small>{{ m.email }}</small></div>
        <button v-if="admin && m.id !== app.me?.user?.id" class="rm" @click="remove(m)">빼기</button>
      </div>
    </div>
    <form v-if="admin" class="add" @submit.prevent="addMember">
      <input v-model="add.name" placeholder="이름" />
      <input v-model="add.email" placeholder="이메일" type="email" required />
      <button class="pill-btn">+ 팀원 추가</button>
    </form>
    <p v-else class="hint ro">팀원 추가·빼기와 역할 담당 지정은 관리자만 할 수 있어요. 바꿀 일이 있으면 관리자에게 알려 주세요.</p>
    <p v-if="err" class="err">{{ err }}</p>

    <p class="cap">역할 담당</p>
    <p class="hint">프로세스 단계는 그 역할을 맡은 팀원에게 가고, 그 사람에게 알림이 갑니다. 비워 두면 일을 시작한 사람(예약을 건 사람)이 맡습니다.</p>
    <input v-model="find" class="find" placeholder="역할·프로세스 검색" />
    <div class="list glass">
      <div v-for="r in shown" :key="r.role" class="li">
        <div class="main"><b>{{ r.role }}</b><small>{{ r.processes.join(' · ') }}</small></div>
        <select :value="held[r.role] || ''" :disabled="!admin" :title="admin ? '' : '관리자만 바꿀 수 있어요'" @change="setRole(r.role, $event.target.value)">
          <option value="">시작한 사람</option>
          <option v-for="m in team" :key="m.id" :value="m.id">{{ m.name }}</option>
        </select>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cap { margin: 18px 4px 8px; color: var(--text-secondary); font-size: 14px; }
.hint { margin: -2px 4px 10px; color: var(--text-tertiary); font-size: 13px; line-height: 1.5; }
.list { border-radius: 20px; overflow: hidden; }
.li { display: flex; align-items: center; gap: 12px; padding: 12px 14px; border-bottom: 1px solid rgba(0, 0, 0, .06); }
.li:last-child { border-bottom: 0; }
.av { width: 34px; height: 34px; border-radius: 17px; background: var(--ink); color: var(--ink-inverse); display: grid; place-items: center; font-size: 15px; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; text-align: left; }
.main b { font-weight: 500; font-size: 15px; }
.main small { color: var(--text-secondary); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.me { color: var(--text-tertiary); font-weight: 400; }
.rm { color: var(--text-secondary); font-size: 13px; }
select { max-width: 46%; height: 34px; border-radius: 10px; padding: 0 8px; background: rgba(255, 255, 255, .7); border: 1px solid rgba(0, 0, 0, .1); font-size: 14px; }
.add { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.add input { flex: 1; min-width: 120px; height: 38px; border-radius: 12px; padding: 0 12px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .7); }
.find { width: 100%; height: 38px; border-radius: 12px; padding: 0 12px; margin-bottom: 8px; border: 1px solid rgba(0, 0, 0, .12); background: rgba(255, 255, 255, .7); }
.err { color: #c62828; font-size: 13px; margin: 6px 4px; }
.hint.ro { margin-top: 10px; }
select:disabled { opacity: .7; }
</style>
