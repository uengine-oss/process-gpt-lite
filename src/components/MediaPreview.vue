<script setup>
// A picture, a sound or a video right in the conversation — the AI chat's file card (Message.vue) and a file sent in a messenger
// room (team/Messenger.vue) show it the same way: a picture as a small thumbnail that opens the viewer (MediaViewer.vue) when
// pressed, a sound and a video with the browser's own player in place. Looking or listening is not editing: no ArtCraft app here
// (src/openPlan.js 'view'). (2026-11-25 「대화창안에서 기본적인 음성 / 이미지가 미리보기 등의 출력이 안되다니..」)
// A sound waits to be pressed before it loads (preload none: a long conversation does not fetch every file); a video shows its
// first frame. One that does not load says so calmly, with its link — no alarm.
// A TIFF (a fax) is a picture too: the app draws its first page small (TiffView.vue, loaded only when one is shown), with 「N쪽」 on it;
// one it cannot draw says 「이 TIFF 는 열 수 없어요 · 내려받기」 (2026-11-25 「tif 파일을 웹에서 못 열어보나?」).
import { ref, computed, watch, defineAsyncComponent } from 'vue'
import { isTiff } from '../mediaKind.js'
import DownloadButton from './DownloadButton.vue'
const TiffView = defineAsyncComponent(() => import('./TiffView.vue'))

const props = defineProps({
  kind: { type: String, required: true },     // image | audio | video (src/mediaKind.js)
  src: { type: String, default: '' },
  name: { type: String, default: '' },
  compact: { type: Boolean, default: false },  // a messenger bubble: smaller
  type: { type: String, default: '' },         // the stored type, when the name says nothing (a TIFF named 「download」)
  // a chat file card's (Message.vue): the thumbnail keeps its tap, its long press · right-click is the card's menu (components/holdMenu.js)
  holdTap: { type: Boolean, default: false },
})
// play: a sound or a video started here (a file a teammate shared: its sender's card says it was opened — team/Messenger.vue)
const emit = defineEmits(['open', 'failed', 'loaded', 'play'])
const failed = ref(false)
const tiff = computed(() => props.kind === 'image' && isTiff({ name: props.name, url: props.src, type: props.type }))
const tiffBad = ref(false)
// a new address (a fresh sign-in token, the file published) tries again
watch(() => props.src, () => { failed.value = false; tiffBad.value = false })
function onError() { failed.value = true; emit('failed') }
// a TIFF whose address did not answer is as any picture's (the messenger asks for a new address); one that is not a TIFF it can draw says so
function onTiffFail(e) { if (e?.fetch) onError(); else tiffBad.value = true }
</script>

<template>
  <div v-if="src" class="mp" :class="[kind, { compact }]" data-test="media-preview" :data-kind="kind" :data-file="name">
    <p v-if="failed" class="calm" data-test="media-fallback">미리 볼 수 없어요 · <a :href="src" target="_blank" rel="noopener">새 창에서 열기</a></p>
    <p v-else-if="tiff && tiffBad" class="calm" data-test="tiff-error">이 TIFF 는 열 수 없어요 · <DownloadButton class="lnk" data-test="tiff-download" :source="{ url: src, name, type: type || 'image/tiff' }">내려받기</DownloadButton></p>
    <button v-else-if="tiff" type="button" class="thumb press" :data-hold-tap="holdTap ? '' : null" :title="name" :aria-label="`${name} 크게 보기`" data-test="media-thumb" @click="emit('open')">
      <TiffView mode="thumb" :src="src" :name="name" @loaded="emit('loaded')" @failed="onTiffFail" />
    </button>
    <button v-else-if="kind === 'image'" type="button" class="thumb press" :data-hold-tap="holdTap ? '' : null" :title="name" :aria-label="`${name} 크게 보기`" data-test="media-thumb" @click="emit('open')">
      <img :src="src" :alt="name" loading="lazy" decoding="async" data-testid="file-image" @error="onError" @load="emit('loaded')" />
    </button>
    <!-- hark: a sound the work made plays right here, on the phone too (recording 2026-11-21) -->
    <audio v-else-if="kind === 'audio'" class="player" controls preload="none" :src="src" data-testid="file-audio" @error="onError" @play="emit('play')" />
    <video v-else class="vplayer" controls playsinline preload="metadata" :src="src" data-testid="file-video" @error="onError" @loadedmetadata="emit('loaded')" @play="emit('play')" />
  </div>
</template>

<style scoped>
.mp { max-width: 100%; }
.mp.audio, .mp.video { width: 100%; }
.mp.compact.audio, .mp.compact.video { width: 280px; }
/* a thumbnail: never wider than the column, never taller than a phone's third; the picture keeps its shape, and the frame is
   just the picture (fit-content: no empty band beside a narrow one) */
.thumb { display: block; width: fit-content; max-width: min(320px, 100%); padding: 0; border-radius: 16px; overflow: hidden;
  background: var(--cell-bg, rgba(127, 127, 127, .12)); cursor: zoom-in; box-shadow: 0 0 0 1px var(--hairline, rgba(127, 127, 127, .2)); }
.thumb img { display: block; max-width: 100%; max-height: 260px; width: auto; height: auto; min-width: 48px; min-height: 48px; object-fit: contain; }
.compact .thumb { border-radius: 12px; max-width: min(240px, 100%); }
.compact .thumb img { max-height: 200px; }
/* a TIFF's first page (TiffView.vue): the same bounds as a picture */
.thumb :deep(canvas) { max-height: 260px; }
.compact .thumb :deep(canvas) { max-height: 200px; }
/* the browser's own controls (play, seek, volume, download) — big enough for a thumb */
.player { display: block; width: 100%; height: 54px; border-radius: 27px; }
.compact .player { height: 44px; }
.vplayer { display: block; width: 100%; max-height: 320px; border-radius: 16px; background: #000; }
.compact .vplayer { max-height: 220px; border-radius: 12px; }
.calm { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--text-secondary); }
.calm a, .calm .lnk { color: inherit; font-weight: 500; text-decoration: underline; }
</style>
