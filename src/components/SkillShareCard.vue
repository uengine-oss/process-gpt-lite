<script setup>
// "이 스킬을 전사에 공유하시겠어요?" — right after a new skill is saved (it starts private) and once
// more after its first successful use. Sharing installs it for the tenant; only the author (and
// bosses of agents using it) can merge proposed changes.
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { folders as F } from '../foldersApi.js'

const props = defineProps({ skill: String, folder: String, after: { type: String, default: 'save' } })
const router = useRouter()
const state = ref('ask') // ask | sharing | shared | private
const err = ref('')
async function share() {
  state.value = 'sharing'; err.value = ''
  try { await F.share(props.folder); state.value = 'shared' } catch (e) { err.value = e.message; state.value = 'ask' }
}
// an old card in the history shows where things stand now
onMounted(async () => {
  const i = props.folder ? await F.skillInfo(props.folder).catch(() => null) : null
  if (i?.visibility === 'tenant') state.value = 'shared'
  else if (i && !i.mine) state.value = 'private'
})
async function keep() { await F.keepPrivate(props.folder).catch(() => {}); state.value = 'private' }
</script>

<template>
  <div class="ssc">
    <template v-if="state === 'shared'">
      <b>전사에 공유했어요</b>
      <p>이제 누구나 '{{ skill }}' 을(를) 쓰고, 고칠 점을 변형으로 제안할 수 있어요. 반영은 작성자와 이 스킬을 쓰는 에이전트의 담당자만 해요.</p>
    </template>
    <template v-else-if="state === 'private'">
      <b>나만 쓸게요</b>
      <p>'{{ skill }}' 은(는) 나와 내 에이전트만 써요. 스킬 폴더에서 언제든 공유할 수 있어요.</p>
    </template>
    <template v-else>
      <b>이 스킬을 전사에 공유하시겠어요?</b>
      <p>{{ after === 'use' ? `'${skill}' 을(를) 잘 썼어요. ` : '' }}지금은 나와 내 에이전트만 써요. 공유하면 누구나 쓰고 고칠 점을 제안할 수 있어요.</p>
      <div class="btns">
        <button class="dark-btn" :disabled="state === 'sharing'" @click="share">{{ state === 'sharing' ? '공유하는 중…' : '전사에 공유' }}</button>
        <button class="pill-btn" @click="keep">나만 쓰기</button>
      </div>
      <p v-if="err" class="err">{{ err }}</p>
    </template>
    <button v-if="folder" class="link" @click="router.push(`/folders/${folder}`)">스킬 폴더 열기 →</button>
  </div>
</template>

<style scoped>
.ssc { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; border-radius: 18px; background: var(--cell-bg); border: 1px solid rgba(123 92 214 / .4); }
b { font-size: 15px; font-weight: 600; }
p { margin: 0; font-size: 13.5px; line-height: 1.55; color: var(--text-secondary); }
.btns { display: flex; gap: 8px; margin-top: 4px; }
.btns > * { height: 38px; font-size: 14px; padding: 0 16px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); }
.err { color: var(--color-error); }
.link { align-self: flex-start; font-size: 13px; color: var(--color-info); margin-top: 2px; }
</style>
