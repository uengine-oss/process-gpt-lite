<script setup>
// 「이 PC 에서 작업 중」 — a variation whose working copy is on this very computer (the desktop app's — src/desktopSeats.js, spec
// variation-seats P1). The person works on it with their own tools; the app commits what is there as it is and sends it up by itself (the
// files went quiet for a minute · a CLI's turn ended there — the switch 「자동으로 올리기」), or now (「지금 올리기」). 「돌려놓기」 sends up
// what is there and takes the working copy off this computer: the variation is then put away (보관 중) and opens anywhere.
// What it shows comes from the app (counts only — never a path): 저장 안 한 변경 N · 안 올린 저장 지점 N · 마지막 올림 …
// dark: the workroom's dark header.
import { ref, computed } from 'vue'
import FIcon from './FIcon.vue'
import { ago } from '../../foldersApi.js'
import { bridge, pcSeatOf, refreshPcSeats, seatWhy } from '../../desktopSeats.js'

const props = defineProps({ vid: String, dark: Boolean })
// busy: what it is doing ('' when done) — the parent keeps this bar while it works, since the app's list can drop the working copy (after
// 「돌려놓기」) before the answer comes back here
const emit = defineEmits(['released', 'say', 'busy'])
const pc = computed(() => pcSeatOf(props.vid))
const hasTrash = typeof bridge()?.openTrash === 'function'
const busy = ref('')
const note = ref([])
// (each sentence its own line: the English dictionary translates each whole)
const say = (...t) => { note.value = t.filter(Boolean); emit('say', note.value[0] || '') }

const counts = computed(() => {
  const p = pc.value
  if (!p) return ''
  const out = []
  if (p.busy) out.push('올리는 중…')
  if (p.dirty) out.push(`저장 안 한 변경 ${p.dirty}`)
  if (p.ahead) out.push(`안 올린 저장 지점 ${p.ahead}`)
  if (!p.dirty && !p.ahead && !p.busy) out.push('모두 올렸어요')
  if (p.pushedAt) out.push(ago(p.pushedAt) === '방금' ? '방금 올림' : `마지막 올림 ${ago(p.pushedAt)}`)
  return out
})
// what holds it up (the app's own word): another branch checked out, a refusal, files left out of the upload
const warn = computed(() => {
  const p = pc.value
  if (!p) return ''
  if (p.branchOk === false) return seatWhy('branch')
  // (a merge the person has not finished there · settings the app does not reach the server with: nothing went up — said until it is cleared)
  if (['in_progress', 'config'].includes(p.why)) return seatWhy(p.why)
  if (p.why && p.why !== 'flagged' && p.state === 'blocked') return seatWhy(p.why)
  if (p.flagged) return `확인이 필요한 파일 ${p.flagged}개는 올리지 않았어요 — 비밀로 보이는 내용 · 링크 · 큰 파일은 이 PC 에만 둬요.`
  // (a pair this PC shows as one file — README.md · readme.md: which name was changed is not known, so it never goes up as it is)
  if (p.unsure) return `확인이 필요한 파일이 ${p.unsure}개 있어요 — 이 PC 에서는 이름이 대소문자(또는 한글 조합)만 다른 두 파일을 하나의 파일로 인식해 어느 쪽을 수정했는지 알 수 없어 올리지 않았어요. 파일은 이 PC 에 그대로 두고, 돌려놓으면 앱 휴지통에 남겨요.`
  return ''
})

async function act(what) {
  const b = bridge()
  if (!b || busy.value) return
  // (a pair this PC shows as one file, changed: named before it goes — it stays in the trash, never pushed)
  const unsure = (pc.value?.unsureFiles || []).join(', ')
  if (what === 'release' && !confirm(unsure ? `이 PC 의 작업본을 그대로 올리고 이 PC 에서 치울까요? 확인이 필요한 파일(${unsure})은 어느 쪽을 수정했는지 알 수 없어 올리지 않고, 앱 휴지통에 30일 동안 보관해요.` : '이 PC 의 작업본을 있는 그대로 올리고 이 PC 에서 치울까요? git 이 싣지 않는 파일(.env · 빌드 산출물 같은 것)은 앱 휴지통에 30일 남겨요.')) return
  busy.value = what; note.value = []
  emit('busy', what)
  try {
    if (what === 'reveal') { const r = await b.reveal(props.vid); if (!r?.ok) say(seatWhy(r?.why)) }
    else if (what === 'terminal') { const r = await b.openTerminal(props.vid); if (!r?.ok) say(r?.why === 'no_terminal' ? '이 PC 에서 터미널을 찾지 못했어요.' : seatWhy(r?.why)) }
    else if (what === 'trash') { const r = await b.openTrash(); if (!r?.ok) say(seatWhy(r?.why)) }
    else if (what === 'save') {
      const r = await b.saveNow(props.vid)
      say(r?.ok ? (r.changed === false ? '올릴 새 변경이 없어요 — 이미 다 올라가 있어요.' : '지금 상태를 이 변형에 올렸어요.') : seatWhy(r?.why))
    } else if (what === 'release') {
      const r = await b.release(props.vid)
      if (!r?.ok) { say(seatWhy(r?.why)); return }
      say('작업본을 돌려놓았어요 — 이 변형은 이제 보관 중이에요.', r.kept ? `이 PC 에만 있던 파일 ${r.kept}개는 앱 휴지통에 30일 남겨 둬요.` : '',
        r.left?.title ? `이어 붙일 수 없던 변경은 「${r.left.title}」 변형으로 올렸어요.` : '',
        r.unsureFiles?.length ? `확인이 필요한 파일(${r.unsureFiles.join(', ')})은 앱 휴지통에 30일 동안 남아 있어요.` : '')
      emit('released', r)
    }
  } catch (e) { say(e.message) } finally { busy.value = ''; emit('busy', ''); refreshPcSeats() }
}
async function setAuto(on) {
  const b = bridge()
  if (!b) return
  await b.setAuto(props.vid, on).catch(() => {})
  refreshPcSeats()
}
</script>

<template>
  <div v-if="pc" class="pcb" :class="{ dark, glass: !dark }" data-test="pc-bar">
    <FIcon name="pc" :size="18" />
    <span class="txt">
      <b>이 PC 에서 작업 중이에요</b>
      <small data-test="pc-counts"><template v-for="(c, i) in counts" :key="i"><span v-if="i" class="dot"> · </span><span>{{ c }}</span></template></small>
      <small v-if="warn" class="warn" data-test="pc-warn">{{ warn }}</small>
      <small v-for="(t, i) in (warn ? [] : note)" :key="`n${i}`" class="ok" role="status">{{ t }}</small>
    </span>
    <label class="auto" title="파일이 1분 동안 조용하거나 CLI 의 턴이 끝나면 저절로 올려요">
      <input type="checkbox" :checked="pc.autoSave !== false" data-test="pc-auto" @change="(e) => setAuto(e.target.checked)" /> 자동으로 올리기
    </label>
    <span class="acts">
      <button class="tb press" data-test="pc-reveal" :disabled="!!busy" @click="act('reveal')"><FIcon name="folder" :size="14" /> 폴더 열기</button>
      <button class="tb press" data-test="pc-terminal" :disabled="!!busy" @click="act('terminal')"><FIcon name="terminal" :size="14" /> 터미널 열기</button>
      <button v-if="hasTrash" class="tb press" data-test="pc-trash" title="이 PC 에만 있던 파일 · 돌려놓은 작업본이 30일 동안 남는 곳" @click="act('trash')"><FIcon name="archive" :size="14" /> 휴지통</button>
      <button class="tb press" data-test="pc-save" :disabled="!!busy || pc.busy" @click="act('save')">{{ busy === 'save' ? '올리는 중…' : '지금 올리기' }}</button>
      <button class="tb press dk" data-test="pc-release" :disabled="!!busy || pc.busy" @click="act('release')"><FIcon name="archive" :size="14" /> {{ busy === 'release' ? '돌려놓는 중…' : '돌려놓기' }}</button>
    </span>
  </div>
</template>

<style scoped>
.pcb { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 14px; border-radius: 16px; font-size: 13.5px; }
.pcb > svg { flex: none; color: #8e6fe6; }
.txt { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 240px; }
.txt b { font-weight: 600; }
.txt small { color: var(--text-secondary); font-size: 12.5px; line-height: 1.5; }
.txt .dot { opacity: .5; }
.txt .warn { color: #d98a2c; }
.txt .ok { color: var(--color-info); }
.auto { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--text-secondary); white-space: nowrap; cursor: pointer; }
.acts { display: flex; gap: 6px; flex-wrap: wrap; }
.tb { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 12px; border-radius: 16px; background: var(--button-bg); font-size: 13px; white-space: nowrap; }
.tb.dk { background: var(--ink); color: var(--ink-inverse); }
.tb:disabled { opacity: .5; }
/* the workroom's dark look */
.pcb.dark { border-radius: 0; padding: 8px 14px; border-bottom: 1px solid #2b2f3a; background: #22263a; color: #c3c8d2; font-size: 13px; }
.pcb.dark > svg { color: #c3a8ff; }
.pcb.dark .txt b { color: #f0f1f4; }
.pcb.dark .txt small, .pcb.dark .auto { color: #9aa0ab; }
.pcb.dark .txt .warn { color: #f5a524; } .pcb.dark .txt .ok { color: #8ab4ff; }
.pcb.dark .tb { height: 28px; border-radius: 7px; background: #262a34; border: 1px solid #2f3440; color: #d8dbe2; }
.pcb.dark .tb.dk { background: #3b4bd1; border-color: #3b4bd1; color: #fff; }
@media (max-width: 600px) {
  .acts { width: 100%; }
  .acts .tb { flex: 1 1 auto; justify-content: center; }
}
</style>
