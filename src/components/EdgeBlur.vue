<script setup>
// Progressive blur: 6 stacked layers (0.15px → 4.8px) each masked to a band,
// so content dissolves under the top bar / composer instead of being clipped.
defineProps({ side: { type: String, default: 'top' }, height: { type: Number, default: 92 } })
const layers = [0.15, 0.3, 0.6, 1.2, 2.4, 4.8]
</script>

<template>
  <div class="edge" :class="side" :style="{ height: height + 'px' }">
    <div v-for="(b, i) in layers" :key="i" class="l"
      :style="{ backdropFilter: `blur(${b}px)`, WebkitBackdropFilter: `blur(${b}px)`, '--a': `${i * 16}%`, '--b': `${i * 16 + 32}%` }" />
  </div>
</template>

<style scoped>
.edge { position: absolute; left: 0; right: 0; z-index: 4; pointer-events: none; }
.edge.top { top: 0; }
.edge.bottom { bottom: 0; transform: scaleY(-1); }
.l { position: absolute; inset: 0;
  -webkit-mask-image: linear-gradient(to bottom, #000 var(--a), transparent var(--b));
  mask-image: linear-gradient(to bottom, #000 var(--a), transparent var(--b)); }
</style>
