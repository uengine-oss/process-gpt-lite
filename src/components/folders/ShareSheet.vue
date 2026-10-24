<script setup>
// 공유: 구성원(사람·에이전트)과 권한. 소유자만 바꿀 수 있어요.
import { ref, computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import Avatar from './Avatar.vue'
import { folders as F, whoOf, roleLabel } from '../../foldersApi.js'

const props = defineProps({ folder: Object, defaultRole: { type: String, default: 'runner' } })
const emit = defineEmits(['close'])
const members = ref(props.folder.members)
const people = ref([])
const add = ref('')
const role = ref(props.defaultRole)
const err = ref('')
const owner = computed(() => props.folder.role === 'owner')
onMounted(async () => { people.value = await F.people().catch(() => []) })
const others = computed(() => people.value.filter((p) => !members.value.some((m) => m.id === String(p.id))))
const ROLE_HELP = { owner: '구성원·폴더 관리', editor: 'main 편집·반영', runner: '변형 만들기·에이전트 실행', viewer: '보기·내려받기' }

async function setRole(m, r) {
  err.value = ''
  try { members.value = await F.setMember(props.folder.slug, { type: m.type, id: m.id, role: r }) } catch (e) { err.value = e.message }
}
async function remove(m) {
  err.value = ''
  try { members.value = await F.removeMember(props.folder.slug, m.type, m.id) } catch (e) { err.value = e.message }
}
async function invite() {
  const p = people.value.find((x) => String(x.id) === add.value)
  if (!p) return
  err.value = ''
  try { members.value = await F.setMember(props.folder.slug, { type: p.isAgent ? 'agent' : 'user', id: p.id, role: role.value }); add.value = '' } catch (e) { err.value = e.message }
}
</script>

<template>
  <div class="veil" @click.self="emit('close')">
    <div class="box glass">
      <header class="hd"><FIcon name="people" :size="19" /><b>공유 — {{ folder.name }}</b><span class="sp" /><button class="ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button></header>
      <div class="body scroll">
        <div v-for="m in members" :key="m.type + m.id" class="mr">
          <Avatar :who="whoOf(m)" :size="30" />
          <span class="mn"><b>{{ m.name }}</b><small>{{ m.is_agent ? (m.agent_type || '에이전트') : m.email || '사람' }}</small></span>
          <select v-if="owner" class="sel" :value="m.role" @change="setRole(m, $event.target.value)">
            <option v-for="(t, k) in roleLabel" :key="k" :value="k">{{ t }} — {{ ROLE_HELP[k] }}</option>
          </select>
          <span v-else class="rl">{{ roleLabel[m.role] }}</span>
          <button v-if="owner" class="ic press" title="빼기" @click="remove(m)"><Icon name="close" :size="14" /></button>
        </div>
        <template v-if="owner">
          <div class="sec">초대하기</div>
          <div class="inv">
            <select v-model="add" class="sel grow">
              <option value="">팀원이나 에이전트를 고르세요</option>
              <optgroup label="팀원"><option v-for="p in others.filter((x) => !x.isAgent)" :key="p.id" :value="String(p.id)">{{ p.name }} ({{ p.email }})</option></optgroup>
              <optgroup label="에이전트"><option v-for="p in others.filter((x) => x.isAgent)" :key="p.id" :value="String(p.id)">{{ p.name }}</option></optgroup>
            </select>
            <select v-model="role" class="sel"><option v-for="(t, k) in roleLabel" :key="k" :value="k">{{ t }}</option></select>
            <button class="dark-btn" :disabled="!add" @click="invite">초대</button>
          </div>
          <p class="fine">권한은 보기 ⊂ 실행 ⊂ 편집 ⊂ 소유 순이에요. 구성원이 아니면 폴더도, 검색 결과도, 에이전트 도구에서도 보이지 않아요.</p>
        </template>
        <p v-if="err" class="bad">{{ err }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(620px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; }
.sp { flex: 1; }
.ic { width: 30px; height: 30px; border-radius: 15px; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.body { padding: 10px 20px 20px; overflow-y: auto; }
.mr { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--hairline); }
.mn { flex: 1; min-width: 0; display: flex; flex-direction: column; } .mn b { font-weight: 500; font-size: 14.5px; } .mn small { font-size: 12px; color: var(--text-secondary); }
.sel { height: 36px; border-radius: 10px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 8px; font-size: 13px; max-width: 240px; }
.sel.grow { flex: 1; max-width: none; }
.rl { font-size: 13px; color: var(--text-secondary); }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 18px 0 8px; }
.inv { display: flex; gap: 8px; align-items: center; }
.inv .dark-btn { height: 38px; padding: 0 16px; }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 10px 0 0; }
.bad { font-size: 13px; color: var(--color-error); }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
</style>
