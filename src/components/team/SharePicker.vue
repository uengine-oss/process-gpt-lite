<script setup>
// Pick teammates (or a role) and add a note: the artifact goes to each in our 1:1 thread, with a
// grant only they can open (server/lib/team/shares.js).
import { ref, computed, onMounted } from 'vue'
import { useTeam } from '../../stores/team.js'
import ConflictChoice from './ConflictChoice.vue'

const team = useTeam()
const data = ref(null)
const picked = ref([])
const note = ref('')
const find = ref('')
const busy = ref(false)
const err = ref('')
const conflicts = ref(null) // returned branches that changed the same file differently: pick, then send

onMounted(async () => { data.value = await team.suggest('fast').catch(() => ({ frequent: [], related: [], roles: [], rest: [] })) })
const rows = computed(() => {
  const d = data.value
  if (!d) return []
  const s = find.value.trim().toLowerCase()
  const hit = (it) => !s || [it.name, it.email, it.role, it.holder?.name, ...(it.roles || [])].some((v) => v && String(v).toLowerCase().includes(s))
  return [
    { key: 'frequent', label: '자주 전달', items: d.frequent },
    { key: 'rest', label: '팀원', items: d.rest },
    { key: 'roles', label: '역할', items: d.roles },
  ].map((x) => ({ ...x, items: x.items.filter(hit) })).filter((x) => x.items.length)
})
const keyOf = (it) => (it.type === 'role' ? `role:${it.role}` : it.id)
const on = (it) => picked.value.some((p) => keyOf(p) === keyOf(it))
const toggle = (it) => { picked.value = on(it) ? picked.value.filter((p) => keyOf(p) !== keyOf(it)) : [...picked.value, it] }
async function send(choices) {
  if (!picked.value.length || busy.value) return
  busy.value = true; err.value = ''
  try {
    await team.share(picked.value.map((p) => (p.type === 'role' ? { type: 'role', role: p.role } : { type: 'user', id: p.id })), note.value.trim(), choices)
    conflicts.value = null
  } catch (e) {
    if (e.conflicts) conflicts.value = e.conflicts
    else err.value = e.message
  } finally { busy.value = false }
}
const initial = (s) => String(s || '?').slice(0, 1)
</script>

<template>
  <div class="veil" @click.self="team.sharing = null">
    <div class="sp glass" role="dialog" aria-label="팀원에게 공유">
      <header>
        <b>팀원에게 공유</b>
        <button class="x press" aria-label="닫기" @click="team.sharing = null">×</button>
      </header>
      <p class="files">{{ team.sharing.names.join(', ') }}</p>
      <input v-model="find" class="find" placeholder="이름·이메일·역할로 찾기" />
      <div class="list">
        <template v-for="s in rows" :key="s.key">
          <p class="sec">{{ s.label }}</p>
          <button v-for="it in s.items" :key="s.key + keyOf(it)" class="row press" :class="{ on: on(it) }" @click="toggle(it)">
            <span class="av" :class="it.type">{{ it.type === 'role' ? '#' : initial(it.name) }}</span>
            <span class="nm"><b>{{ it.type === 'role' ? it.role : it.name }}</b><small>{{ it.type === 'role' ? `담당 ${it.holder?.name}` : (it.roles || []).join(', ') || it.email }}</small></span>
            <em v-if="it.why === 'frequent'" class="tag">{{ it.n }}번 전달</em>
            <span class="ck">{{ on(it) ? '✓' : '' }}</span>
          </button>
        </template>
        <p v-if="data && !rows.length" class="none">공유할 팀원이 없어요. 설정 → 팀·역할에서 팀원을 추가해 주세요.</p>
      </div>
      <textarea v-model="note" class="note" rows="2" maxlength="1000" placeholder="메모 (예: 숫자 맞는지 봐 주세요)" />
      <ConflictChoice v-if="conflicts" :conflicts="conflicts" :busy="busy" @pick="send" @cancel="conflicts = null" />
      <p v-if="err" class="err">{{ err }}</p>
      <footer>
        <small>받는 분만 열 수 있어요 · 받는 분의 작업 대화로 가요</small>
        <button class="send press" :disabled="!picked.length || busy || !!conflicts" @click="send()">{{ busy ? '보내는 중…' : picked.length ? `${picked.length}명에게 보내기` : '받을 사람 고르기' }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; background: rgba(20, 24, 32, .22); padding: 16px; }
.sp { width: min(420px, 100%); max-height: min(640px, 92vh); display: flex; flex-direction: column; border-radius: 24px; padding: 16px; box-shadow: 0 20px 60px rgba(0, 0, 0, .25); color: var(--text-primary); }
header { display: flex; align-items: center; }
header b { flex: 1; font-size: 17px; font-weight: 600; }
.x { width: 30px; height: 30px; border-radius: 15px; font-size: 20px; color: var(--text-secondary); }
.files { margin: 4px 0 10px; font-size: 13px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.find, .note { width: 100%; border: 1px solid rgba(127, 127, 127, .3); background: rgba(127, 127, 127, .06); border-radius: 12px; padding: 9px 12px; font-size: 14px; color: var(--text-primary); outline: 0; resize: none; font-family: inherit; }
.list { flex: 1; overflow: auto; margin: 8px 0; min-height: 120px; }
.sec { margin: 8px 6px 4px; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
.row { width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 12px; text-align: left; color: var(--text-primary); }
.row:hover { background: rgba(127, 127, 127, .1); }
.row.on { background: rgba(42, 120, 214, .14); }
.av { flex: none; width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; font-weight: 600; color: #fff; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); }
.av.role { background: #0f8a5f; border-radius: 10px; }
.nm { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.nm b { font-size: 14.5px; font-weight: 500; } .nm small { font-size: 12px; color: var(--text-secondary); }
.tag { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; background: rgba(42, 120, 214, .14); color: #2a78d6; }
.ck { width: 22px; height: 22px; border-radius: 11px; display: grid; place-items: center; font-size: 13px; color: #fff; background: rgba(127, 127, 127, .2); }
.row.on .ck { background: #2a78d6; }
.none { font-size: 13px; color: var(--text-secondary); margin: 12px 6px; }
.err { color: #c62828; font-size: 13px; margin: 6px 2px 0; }
footer { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
footer small { flex: 1; font-size: 11.5px; color: var(--text-tertiary); }
.send { height: 40px; padding: 0 18px; border-radius: 20px; background: #1d1d1f; color: #fff; font-size: 14.5px; font-weight: 500; }
:root[data-theme="dark"] .send { background: #f5f5f7; color: #1d1d1f; }
.send:disabled { opacity: .45; }
</style>
