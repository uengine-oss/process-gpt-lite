<script setup>
// One person's tile: their camera (or screen), name, mic and consent state, the language they speak and
// — while the interpreter speaks for them — the "AI 통역" badge. The video element is handed up (@el)
// so the meeting can lower this person's own voice while their interpretation plays (duck.js).
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { langLabel } from '../../i18n/mainLangs.js'

const props = defineProps({ stream: Object, name: String, me: Boolean, muted: Boolean, camOff: Boolean, consent: Boolean, state: String, level: Number, screen: Boolean, lang: String, showLang: Boolean, interpreting: Boolean })
const emit = defineEmits(['el'])
const v = ref(null)
const attach = () => { if (v.value && v.value.srcObject !== (props.stream || null)) v.value.srcObject = props.stream || null }
onMounted(() => { attach(); emit('el', v.value) })
onBeforeUnmount(() => emit('el', null))
watch(() => props.stream, attach)
</script>

<template>
  <div class="tile" :class="{ me, off: camOff || !stream, talking: (level || 0) > 0.12, interp: interpreting }" :data-test="interpreting ? 'tile-interpreting' : null">
    <video v-show="stream && !camOff" ref="v" autoplay playsinline :muted="me" />
    <div v-if="camOff || !stream" class="av">{{ String(name || '?').slice(0, 1) }}</div>
    <div class="nm">
      <span>{{ name }}{{ me ? ' (나)' : '' }}</span>
      <i v-if="muted" class="tag" title="마이크 꺼짐">음소거</i>
      <i v-if="screen" class="tag scr">화면 공유</i>
      <i v-if="!consent" class="tag nc" title="이분의 말은 받아쓰지 않아요">기록 안 함</i>
      <i v-if="showLang && lang" class="tag lg" data-no-i18n>{{ langLabel(lang) }}</i>
    </div>
    <div v-if="interpreting" class="ai" data-test="ai-interp-badge">AI 통역</div>
    <div v-if="state && state !== 'connected' && !me" class="conn">{{ state === 'failed' ? '연결하지 못했어요' : '연결 중…' }}</div>
  </div>
</template>

<style scoped>
.tile { position: relative; border-radius: 18px; overflow: hidden; background: #1c1f26; aspect-ratio: 16 / 9; min-height: 0; box-shadow: 0 0 0 2px transparent; transition: box-shadow .2s; }
.tile.talking { box-shadow: 0 0 0 3px #3ccf91; }
video { width: 100%; height: 100%; object-fit: cover; display: block; }
.av { position: absolute; inset: 0; display: grid; place-items: center; font-size: 42px; font-weight: 600; color: #fff; background: linear-gradient(135deg, #5c6f9e, #2f3c62); }
.nm { position: absolute; left: 10px; bottom: 8px; right: 10px; display: flex; align-items: center; gap: 6px; color: #fff; font-size: 14px; font-weight: 500; text-shadow: 0 1px 3px rgba(0, 0, 0, .6); }
.tag { font-style: normal; font-size: 11px; padding: 2px 7px; border-radius: 8px; background: rgba(0, 0, 0, .5); text-shadow: none; }
.tag.nc { background: rgba(229, 72, 77, .85); }
.tag.scr { background: rgba(42, 120, 214, .85); }
.tag.lg { background: rgba(255, 255, 255, .18); }
.tile.interp { box-shadow: 0 0 0 3px #a996ff; }
.ai { position: absolute; top: 10px; left: 10px; font-size: 11.5px; font-weight: 600; color: #fff; padding: 3px 9px; border-radius: 9px; background: linear-gradient(90deg, #7a5af5, #2a78d6); box-shadow: 0 2px 8px rgba(0, 0, 0, .3); }
.conn { position: absolute; top: 10px; right: 10px; font-size: 12px; color: #fff; background: rgba(0, 0, 0, .5); padding: 3px 9px; border-radius: 9px; }
</style>
