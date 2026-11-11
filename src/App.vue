<script setup>
import { onMounted } from 'vue'
import SkyCanvas from './sky/SkyCanvas.vue'
import AppSheet from './apps/AppSheet.vue'
import { useSky } from './stores/sky.js'

const sky = useSky()
onMounted(() => sky.init())
</script>

<template>
  <div class="stage">
    <SkyCanvas />
    <RouterView v-slot="{ Component }">
      <Transition name="fade" mode="out-in">
        <component :is="Component" />
      </Transition>
    </RouterView>
    <AppSheet />
  </div>
</template>

<style scoped>
.stage { position: fixed; inset: 0; overflow: clip; }
</style>
