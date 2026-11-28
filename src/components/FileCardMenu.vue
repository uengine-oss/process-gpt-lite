<script setup>
// A chat file card's menu (2026-11-28 휴대폰 사진: under every file card 「‘…’에 정리할까요? (확신 65%) [정리] · 다른 폴더 고르기」 took most
// of the screen — 「화면이 정신없으니 하단의 공유, 프로젝트로 등록, 폴더 정리 등 모든 것들 콘텍스트 메뉴로. 모바일에선 길게 누를때」). Opened by
// holding the card (a phone), right-clicking it or its ⋯ (a computer — Message.vue); pressing the card still opens the file.
//   menu   열기 (what pressing the card does) · 팀원에게 공유 (a card that can be shared) · 폴더에 정리: the judge's folder 「‘견적서’에 정리」
//          (확신도 N%) or a new one 「새 폴더를 만들어 정리: <이름>」, 「다른 폴더 고르기」 — filed: 「‘…’에 정리했어요 · 폴더에서 열어요」
//   pick   the folders that can take it (edit or more, server lib/folders/filing.js) and a new folder's name
// The filing itself is the card's (useFiling.js — the card's dot shows while a suggestion waits).
import { ref, computed, onMounted, nextTick } from 'vue'
import Icon from './Icon.vue'
import { useTeam, shareable } from '../stores/team.js'
import { menuKeys } from '../menuKeys.js'

// filing: the card's useFiling() (null: a card that is not filed — one opened from a folder, one with no file behind it)
// hint: what pressing the card does (「눌러서 바로 편집」 …) · from: where the focus goes back to (the ⋯; none after a long press)
const props = defineProps({ msg: Object, filing: { type: Object, default: null }, hint: { type: String, default: '' }, from: { type: Object, default: null } })
const emit = defineEmits(['close', 'open'])
const team = useTeam()
const step = ref('menu')
const sheet = ref(null)
const c = computed(() => props.msg?.content || {})
const f = computed(() => props.filing)
// (a private card — a mail's attachment, its edit: mine only — has no 공유, as its card had no 공유 button)
const canShare = computed(() => !c.value.private && shareable(props.msg))

function close(back = false) {
  emit('close')
  if (back && props.from?.isConnected) props.from.focus?.({ preventScroll: true })
}
async function focusFirst() {
  await nextTick()
  ;(sheet.value?.querySelector('[role="menuitem"]:not([disabled])') || sheet.value?.querySelector('input') || sheet.value)?.focus?.()
}
onMounted(() => { f.value?.load?.(); focusFirst() })
function open() { emit('open'); close() }
function share() { const m = props.msg; close(); team.startShare([m]) }
async function file(to) { if (await f.value.fileIt(to)) close(true) }
async function pick() {
  f.value.err = ''
  step.value = 'pick'
  // (the sheet holds the focus — Esc still closes it — while the folders come; then the first of them, unless the person went on already)
  await nextTick()
  sheet.value?.focus()
  await f.value.loadList()
  if (document.activeElement === sheet.value || !sheet.value?.contains(document.activeElement)) focusFirst()
}
function back() { step.value = 'menu'; f.value.err = ''; focusFirst() }
function openFolder() { close(); f.value.openFolder() }
const newName = computed({ get: () => f.value?.newName || '', set: (v) => { f.value.newName = v } })
</script>

<template>
  <Teleport to="body">
    <div class="veil" data-test="file-menu-veil" @click.self="close(true)">
      <div ref="sheet" class="sheet glass blur-in" role="dialog" aria-modal="true" aria-label="파일 메뉴" tabindex="-1" data-test="file-menu" :data-step="step"
        @keydown.esc.stop.prevent="close(true)">
        <header>
          <button v-if="step === 'pick'" class="x press" aria-label="뒤로" data-test="file-menu-back" @click="back"><Icon name="back" :size="17" /></button>
          <div class="hd">
            <h2>{{ step === 'pick' ? '정리할 폴더 고르기' : '파일' }}</h2>
            <p class="sub" data-no-i18n>{{ c.name }}</p>
          </div>
          <button class="x press" aria-label="닫기" data-test="file-menu-close" @click="close(true)"><Icon name="close" :size="17" /></button>
        </header>

        <div v-if="step === 'menu'" class="menu" role="menu" @keydown="menuKeys">
          <button class="mi press" role="menuitem" data-test="file-menu-open" @click="open">
            <span class="ic"><Icon name="eye" :size="18" /></span><span class="mt"><b>열기</b><small v-if="hint">{{ hint }}</small></span>
          </button>
          <button v-if="canShare" class="mi press" role="menuitem" data-test="file-menu-share" @click="share">
            <span class="ic"><Icon name="team" :size="18" /></span><span class="mt"><b>팀원에게 공유</b><small>팀원을 골라 이 파일을 보내요</small></span><Icon name="chevron" :size="14" />
          </button>
          <template v-if="f">
            <p class="sec">폴더에 정리</p>
            <button v-if="f.filed" class="mi press" role="menuitem" data-test="file-menu-filed" @click="openFolder">
              <span class="ic ok"><Icon name="check" :size="18" /></span>
              <span class="mt"><b>{{ f.filed.already ? `이미 ‘${f.filed.name}’에 있어요` : `‘${f.filed.name}’에 정리했어요` }}</b><small>폴더에서 열어요</small></span><Icon name="chevron" :size="14" />
            </button>
            <template v-else>
              <button v-if="f.state === 'loading' || f.state === 'idle'" class="mi" role="menuitem" disabled data-test="file-menu-finding">
                <span class="ic"><Icon name="folder" :size="18" /></span><span class="mt"><b class="shimmer-text">알맞은 폴더를 찾고 있어요…</b></span>
              </button>
              <button v-else-if="f.sug?.folder" class="mi press" role="menuitem" data-test="file-menu-file" :disabled="f.busy" @click="file({ slug: f.sug.folder.slug, sub: f.sug.sub || '' })">
                <span class="ic"><Icon name="folder" :size="18" /></span>
                <span class="mt"><b data-test="file-menu-file-label">{{ f.busy ? '정리하는 중…' : `‘${f.where}’에 정리` }}</b><small>추천 · 확신도 {{ f.pct }}%</small></span><i class="tag">추천</i>
              </button>
              <button v-else-if="f.sug?.newFolder" class="mi press" role="menuitem" data-test="file-menu-new" :disabled="f.busy" @click="file({ newFolder: f.sug.newFolder.name })">
                <span class="ic"><Icon name="plus" :size="18" /></span>
                <span class="mt"><b data-test="file-menu-new-label">{{ f.busy ? '만드는 중…' : `새 폴더를 만들어 정리: ${f.sug.newFolder.name}` }}</b><small>맞는 폴더가 없어 새 폴더를 추천해요</small></span><i class="tag">추천</i>
              </button>
              <button v-if="f.state !== 'loading' && f.state !== 'idle'" class="mi press" role="menuitem" data-test="file-menu-other" @click="pick">
                <span class="ic"><Icon name="list" :size="18" /></span><span class="mt"><b>{{ f.sug?.folder || f.sug?.newFolder ? '다른 폴더 고르기' : '폴더 고르기' }}</b><small>편집할 수 있는 폴더 중에서 직접 골라요</small></span><Icon name="chevron" :size="14" />
              </button>
            </template>
          </template>
        </div>

        <template v-else-if="step === 'pick' && f">
          <div class="menu list scroll" role="menu" aria-label="정리할 폴더" data-test="file-menu-pick" @keydown="menuKeys">
            <p v-if="!f.list" class="wait shimmer-text">폴더를 불러오는 중…</p>
            <p v-else-if="!f.list.length" class="none">정리할 수 있는 폴더가 없어요. 편집 권한이 있는 폴더만 고를 수 있어요.</p>
            <button v-for="x in f.list || []" :key="x.slug" class="mi opt press" role="menuitem" data-test="file-menu-folder" :data-slug="x.slug" :disabled="f.busy" @click="file({ slug: x.slug })">
              <span class="ic"><Icon name="folder" :size="16" /></span><span class="mt"><b data-no-i18n>{{ x.name }}</b></span>
            </button>
          </div>
          <form class="nf" @submit.prevent="newName.trim() && file({ newFolder: newName.trim() })">
            <input v-model="newName" placeholder="새 폴더 이름" maxlength="40" aria-label="새 폴더 이름" data-test="file-menu-new-name" />
            <button class="go press" type="submit" :disabled="f.busy || !newName.trim()" data-test="file-menu-new-go">새 폴더에 정리</button>
          </form>
        </template>

        <p v-if="f?.err" class="err" role="alert" data-test="file-menu-error">{{ f.err }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* (the answer's menu's look — AnswerShareSheet.vue: a dialog on a computer, a sheet from the bottom on a phone) */
.veil { position: fixed; inset: 0; z-index: 200; background: rgba(0, 0, 0, .28); display: grid; place-items: center; padding: 16px; }
.sheet { width: min(420px, 100%); min-width: 0; box-sizing: border-box; max-height: min(80vh, 640px); max-height: min(80dvh, 640px); border-radius: 26px; padding: 16px 16px 14px;
  display: flex; flex-direction: column; gap: 8px; background: var(--regular-solid-bg, var(--bubble-agent-bg)); box-shadow: var(--shadow-card); color: var(--text-primary); }
.sheet:focus { outline: none; }
header { display: flex; align-items: flex-start; gap: 8px; }
.hd { flex: 1; min-width: 0; }
h2 { margin: 2px 0 0; font-size: 17px; font-weight: 600; }
.sub { margin: 3px 0 0; font-size: 12.5px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x { width: 32px; height: 32px; border-radius: 50%; display: grid; place-items: center; background: var(--field-bg); flex: none; color: var(--text-primary); }
.menu { display: flex; flex-direction: column; gap: 2px; min-height: 0; }
.list { overflow: auto; }
.mi { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 7px 10px; border-radius: 16px; text-align: left; color: var(--text-primary); }
.mi:hover:not(:disabled) { background: var(--cell-bg, rgba(127, 127, 127, .1)); }
.mi:disabled { opacity: .6; }
.mi.opt { min-height: 44px; }
.ic { width: 36px; height: 36px; border-radius: 12px; display: grid; place-items: center; flex: none; background: var(--field-bg); }
.ic.ok { color: var(--color-success); }
.mt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.mt b { font-size: 14.5px; font-weight: 600; overflow-wrap: anywhere; }
.mt small { font-size: 12px; color: var(--text-secondary); line-height: 1.35; overflow-wrap: anywhere; }
.sec { margin: 8px 10px 2px; font-size: 11.5px; font-weight: 600; color: var(--text-secondary); }
.tag { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; background: rgba(42, 120, 214, .16); color: var(--color-info); flex: none; }
.none, .wait { font-size: 13px; color: var(--text-secondary); margin: 8px 4px; }
.nf { display: flex; gap: 6px; }
.nf input { flex: 1; min-width: 0; height: 38px; padding: 0 12px; border-radius: 12px; border: 1px solid var(--hairline); background: var(--field-bg); color: var(--text-primary); font: inherit; font-size: 14px; outline: 0; }
.go { flex: none; height: 38px; padding: 0 14px; border-radius: 19px; background: var(--text-primary); color: var(--text-primary-on); font-size: 13.5px; font-weight: 600; }
.go:disabled { opacity: .45; }
.err { margin: 0; color: var(--color-error, #c62828); font-size: 12.5px; overflow-wrap: anywhere; }
@media (max-width: 760px) {
  .veil { place-items: end stretch; padding: 0; }
  .sheet { width: 100%; max-height: 86vh; max-height: 86dvh; border-radius: 24px 24px 0 0; padding: 16px 16px calc(14px + env(safe-area-inset-bottom, 0px)); }
}
</style>
