<script setup>
import { onMounted } from 'vue'
import SkyCanvas from './sky/SkyCanvas.vue'
import { useSky } from './stores/sky.js'
import { newVersion, watchVersion } from './appVersion.js'
import { runner } from './localRunner.js'

const sky = useSky()
onMounted(() => { sky.init(); watchVersion() })
const reload = () => location.reload()
const later = () => { newVersion.value = false }
</script>

<template>
  <div class="stage">
    <SkyCanvas />
    <RouterView v-slot="{ Component }">
      <Transition name="fade" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
    <!-- the desktop app: a CLI agent of this computer is running one of this person's steps (src/localRunner.js) -->
    <button v-if="runner.status?.running?.length" class="localrun press" role="status" data-test="local-run-pill" :title="runner.status.running.map((r) => `${r.label} · ${r.activity}`).join('\n')"
      @click="runner.status.running[0]?.instId && $router.push(`/routines/${encodeURIComponent(runner.status.running[0].instId)}`)">
      <span class="dot" />로컬 에이전트 실행 중 · {{ [...new Set(runner.status.running.map((r) => r.label))].join(' · ') }}<template v-if="runner.status.running.length > 1"> ({{ runner.status.running.length }})</template>
    </button>
    <!-- a newer build was deployed while this page stayed open: reload to get it (appVersion.js) -->
    <div v-if="newVersion" class="newver" role="status" data-test="new-version">
      <span>새 버전이 나왔어요. 새로 고침하면 바로 적용돼요.</span>
      <button class="go press" @click="reload">새로 고침</button>
      <button class="x press" aria-label="닫기" @click="later">✕</button>
    </div>
  </div>
</template>

<style scoped>
.stage { position: fixed; inset: 0; overflow: clip; }
.localrun { position: fixed; z-index: 89; right: 16px; bottom: calc(env(safe-area-inset-bottom, 0px) + 16px); display: flex; align-items: center; gap: 8px;
  max-width: calc(100vw - 32px); padding: 7px 14px; border-radius: 18px; background: #1d1d1f; color: #f5f5f7; font-size: 13px; box-shadow: 0 8px 24px rgba(0, 0, 0, .28);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
.localrun .dot { width: 8px; height: 8px; border-radius: 4px; background: #34c759; flex: none; animation: pulse 1.6s ease-in-out infinite; }
.newver { position: fixed; z-index: 90; left: 50%; transform: translateX(-50%); top: calc(env(safe-area-inset-top, 0px) + 10px);
  display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px); padding: 7px 8px 7px 16px; border-radius: 22px;
  background: #1d1d1f; color: #f5f5f7; font-size: 13.5px; box-shadow: 0 10px 30px rgba(0, 0, 0, .3); }
.newver .go { height: 30px; padding: 0 14px; border-radius: 15px; background: #7a5af5; color: #fff; font-size: 13px; flex: none; }
.newver .x { width: 28px; height: 28px; border-radius: 14px; color: #b8b8c0; flex: none; }
</style>
