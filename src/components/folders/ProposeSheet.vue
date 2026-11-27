<script setup>
// 원본에 반영 요청 (server lib/folders/templates.js): from a project's own workspace, the files that came from its template and changed here —
// picked one by one — go to the template as a new variation of its own, on the template's main as it is now; the template's owner
// reviews and merges it. The project's outputs (its 산출물/ and every new file) are listed apart and never go.
import { ref, computed, onMounted } from 'vue'
import Icon from '../Icon.vue'
import FIcon from './FIcon.vue'
import { folders as F } from '../../foldersApi.js'
import { baseName, dirName } from './fileKind.js'

const props = defineProps({ slug: String, vid: String })
const emit = defineEmits(['close', 'done'])
const info = ref(null)
const picked = ref(new Set())
const title = ref('')
const note = ref('')
const busy = ref(false)
const err = ref('')
onMounted(async () => {
  try {
    info.value = await F.proposal(props.slug, props.vid)
    picked.value = new Set(info.value.files.map((f) => f.path))
    title.value = info.value.files.length === 1 ? `${baseName(info.value.files[0].path)} 고침` : '템플릿 고침'
  } catch (e) { err.value = e.message }
})
const toggle = (p) => { const s = new Set(picked.value); s.has(p) ? s.delete(p) : s.add(p); picked.value = s }
const ok = computed(() => picked.value.size > 0 && title.value.trim() && !busy.value)
const CH = { M: '고침', D: '지움', A: '새 파일' }
async function submit() {
  busy.value = true; err.value = ''
  try {
    const r = await F.propose(props.slug, props.vid, { paths: [...picked.value], title: title.value.trim(), note: note.value.trim() })
    emit('done', r)
  } catch (e) { err.value = e.message } finally { busy.value = false }
}
</script>

<template>
  <div class="veil" data-test="propose-sheet" @click.self="emit('close')">
    <div class="box glass">
      <header class="hd"><FIcon name="merge" :size="19" /><b>원본에 반영 요청<template v-if="info"> — 템플릿 「{{ info.template.name }}」</template></b><span class="sp" /><button class="ic press" title="닫기" @click="emit('close')"><Icon name="close" :size="16" /></button></header>
      <div class="body scroll">
        <p v-if="!info && !err" class="fine">불러오는 중…</p>
        <template v-if="info">
          <div class="sec">템플릿에서 온 파일 중 이 프로젝트에서 바뀐 것</div>
          <label v-for="f in info.files" :key="f.path" class="fr" :class="{ on: picked.has(f.path) }" data-test="propose-file" :data-file="f.path">
            <input type="checkbox" :checked="picked.has(f.path)" @change="toggle(f.path)" />
            <span class="nm"><b>{{ baseName(f.path) }}</b><small>{{ dirName(f.path) || '/' }} · {{ CH[f.change] || f.change }}</small></span>
            <span v-if="!f.binary && f.add != null" class="pm"><i class="a">+{{ f.add }}</i> <i class="d">−{{ f.del }}</i></span>
          </label>
          <p v-if="!info.files.length" class="fine" data-test="propose-none">템플릿에서 온 파일 가운데 바뀐 것이 없어요.</p>
          <div class="sec">이 프로젝트에만 남는 결과물 · 보내지 않아요</div>
          <div v-for="f in info.outputs" :key="f.path" class="fr out" data-test="propose-output" :data-file="f.path">
            <FIcon name="lock" :size="15" /><span class="nm"><b>{{ baseName(f.path) }}</b><small>{{ dirName(f.path) || '/' }}</small></span>
          </div>
          <p v-if="!info.outputs.length" class="fine">아직 결과물이 없어요.</p>
          <div class="sec">요청 제목</div>
          <input v-model="title" class="fld" maxlength="80" aria-label="요청 제목" />
          <div class="sec">템플릿 주인에게 한마디 (선택)</div>
          <textarea v-model="note" class="fld ta" placeholder="예: 회사 주소가 옛 주소라 새 주소로 바꿨어요" aria-label="한마디" />
          <p class="fine">고른 파일만 템플릿의 지금 main 위에 새 변형으로 올라가요. 템플릿 주인이 그 변형을 보고 반영하면 다음 프로젝트부터 고친 내용으로 시작해요.</p>
        </template>
        <p v-if="err" class="bad" data-test="propose-error">{{ err }}</p>
      </div>
      <footer class="ft">
        <button class="pill-btn" @click="emit('close')">취소</button>
        <button class="dark-btn" data-test="propose-send" :disabled="!ok" @click="submit">{{ busy ? '보내는 중…' : `${picked.size}개 보내기` }}</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.veil { position: fixed; inset: 0; z-index: 45; background: rgba(20, 24, 32, .3); display: grid; place-items: center; padding: 24px; animation: fade-in .2s both; }
.box { width: min(620px, 100%); max-height: calc(100vh - 48px); border-radius: 24px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 18px 60px rgba(0, 0, 0, .3); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.hd { display: flex; align-items: center; gap: 10px; min-height: 58px; padding: 0 14px 0 20px; border-bottom: 1px solid var(--hairline); font-size: 16px; flex: none; }
.hd b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.sp { flex: 1; }
.ic { width: 32px; height: 32px; border-radius: 16px; display: grid; place-items: center; background: var(--button-bg); flex: none; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 20px 18px; }
.sec { font-size: 12.5px; color: var(--text-tertiary); margin: 16px 0 8px; letter-spacing: .04em; }
.fr { display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 14px; background: var(--cell-bg); border: 1.5px solid transparent; margin-bottom: 6px; cursor: pointer; }
.fr.on { border-color: var(--color-info); }
.fr.out { cursor: default; color: var(--text-secondary); }
.fr input { width: 18px; height: 18px; flex: none; accent-color: var(--color-info); }
.nm { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.nm b { font-weight: 500; font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nm small { font-size: 12px; color: var(--text-secondary); }
.pm { font-size: 12.5px; font-style: normal; flex: none; } .pm i { font-style: normal; } .pm .a { color: #1a8f4c; } .pm .d { color: #d23c3c; }
.fld { width: 100%; height: 42px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); padding: 0 12px; font-size: 14px; outline: 0; }
.ta { height: 68px; padding: 10px 12px; resize: none; }
.fine { font-size: 12.5px; color: var(--text-secondary); line-height: 1.6; margin: 10px 0 0; }
.bad { font-size: 13px; color: var(--color-error); margin-top: 12px; }
.ft { display: flex; justify-content: flex-end; gap: 10px; padding: 12px 16px; border-top: 1px solid var(--hairline); flex: none; }
.ft > * { height: 42px; }
.dark-btn { background: var(--ink); color: var(--ink-inverse); padding: 0 18px; border-radius: 21px; }
@media (max-width: 560px) { .veil { padding: 12px; place-items: end center; } .box { border-radius: 22px; } }
</style>
