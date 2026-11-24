<script setup>
// The app's own viewer of a picture, a sound or a video (src/openPlan.js 'view', artifacts.js viewMedia): over everything — the
// chat, the document panel, the messenger — the file at its size, 「새 창에서 열기」, and only where this install has the ArtCraft
// app for it 「PhotoCraft 로 편집」 (VectorCraft · SoundCraft · FilmCraft). Opening a picture is looking at it; its editor opens only
// when the person asks to edit (2026-11-25 「포토크래프트등의 편집기는 편집의 의도가 있을따만 시도하는 것이고」).
// It closes with ✕, Esc or a press outside the file, back to where it was opened (a floating messenger stays open under it).
// A picture pressed switches between fitting the screen and its own size (then it scrolls); a phone pinches it as any page.
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import Icon from './Icon.vue'
import { useApp } from '../stores/app.js'
import { CRAFT_NAMES } from '../editorKinds.js'

const app = useApp()
const v = computed(() => app.media)
const zoom = ref(false)
const busy = ref(false)
const note = ref('')
const closeBtn = ref(null)
const opener = typeof document !== 'undefined' ? document.activeElement : null
const close = () => { app.media = null }
watch(v, () => { zoom.value = false; note.value = ''; busy.value = false })
// 「… 로 편집」: the editor opens (the document panel), the viewer goes; when it cannot, the reason stays here
async function edit() {
  if (!v.value?.edit || busy.value) return
  busy.value = true; note.value = ''
  try {
    const r = await v.value.edit()
    if (r && r.opened === false) { note.value = r.reason || '편집기를 열지 못했어요.'; return }
    close()
  } catch (e) { note.value = e.message || '편집기를 열지 못했어요.' } finally { busy.value = false }
}
// (ahead of the messenger's own Esc, which would put a floating messenger away too)
const onKey = (e) => { if (e.key === 'Escape' && v.value) { e.stopImmediatePropagation(); e.preventDefault(); close() } }
onMounted(async () => { window.addEventListener('keydown', onKey, true); await nextTick(); closeBtn.value?.focus({ preventScroll: true }) })
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey, true); if (opener?.isConnected) opener.focus?.({ preventScroll: true }) })
</script>

<template>
  <Teleport to="body">
    <div v-if="v" class="mv" role="dialog" aria-modal="true" :aria-label="v.name" data-test="media-viewer" :data-kind="v.kind" @click.self="close">
      <header class="mvh">
        <b class="nm" :title="v.name">{{ v.name }}</b>
        <button ref="closeBtn" type="button" class="x press" aria-label="닫기" data-test="media-close" @click="close"><Icon name="close" :size="18" /></button>
      </header>
      <div class="stage" :class="{ zoom }" @click.self="close">
        <img v-if="v.kind === 'image'" :src="v.url" :alt="v.name" class="full" data-test="media-full" @click="zoom = !zoom" />
        <video v-else-if="v.kind === 'video'" :src="v.url" class="full" controls playsinline preload="metadata" data-test="media-full" />
        <audio v-else :src="v.url" class="aud" controls preload="metadata" data-test="media-full" />
      </div>
      <footer class="mvf" @click.self="close">
        <p v-if="note" class="note" role="status" data-test="media-note">{{ note }}</p>
        <a class="act press" :href="v.url" target="_blank" rel="noopener" data-test="media-open">새 창에서 열기</a>
        <button v-if="v.editWith && v.edit" type="button" class="act main press" :disabled="busy" data-test="media-edit" :data-editor="v.editWith" @click="edit">{{ CRAFT_NAMES[v.editWith] || v.editWith }} 로 편집</button>
      </footer>
    </div>
  </Teleport>
</template>

<style scoped>
/* dark in both themes, like any photo viewer: the picture is what shows */
.mv { position: fixed; inset: 0; z-index: 300; display: flex; flex-direction: column; background: rgba(8, 10, 14, .92); color: #f5f5f7;
  -webkit-backdrop-filter: blur(14px); backdrop-filter: blur(14px); animation: mv-in .22s ease-out both; }
@keyframes mv-in { from { opacity: 0; } to { opacity: 1; } }
.mvh { flex: none; display: flex; align-items: center; gap: 10px; padding: calc(env(safe-area-inset-top, 0px) + 10px) 12px 8px 18px; }
.nm { flex: 1; min-width: 0; font-size: 15px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x { flex: none; width: 40px; height: 40px; border-radius: 20px; display: grid; place-items: center; background: rgba(255, 255, 255, .14); color: #fff; }
.stage { flex: 1 1 auto; min-height: 0; display: flex; padding: 4px 16px; overflow: auto; overscroll-behavior: contain; }
/* centred while it fits, scrollable from its edge when it does not (margin: auto) */
.full { margin: auto; display: block; max-width: 100%; max-height: 100%; object-fit: contain; border-radius: 6px; cursor: zoom-in; }
.stage.zoom .full { max-width: none; max-height: none; cursor: zoom-out; }
video.full { background: #000; cursor: auto; width: min(960px, 100%); }
.aud { margin: auto; width: min(480px, 100%); }
.mvf { flex: none; display: flex; flex-wrap: wrap; align-items: center; justify-content: center; gap: 8px; padding: 10px 16px calc(env(safe-area-inset-bottom, 0px) + 16px); }
.act { display: inline-flex; align-items: center; height: 40px; padding: 0 18px; border-radius: 20px; background: rgba(255, 255, 255, .14); color: #fff;
  font-size: 14px; font-weight: 500; text-decoration: none; white-space: nowrap; }
.act.main { background: #7a5af5; }
.act:disabled { opacity: .6; }
.note { flex-basis: 100%; margin: 0; text-align: center; font-size: 13px; color: #ffd38a; }
</style>
