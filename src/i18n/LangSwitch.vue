<script setup>
// 「언어 / Language」: 한국어 ↔ English. Saved on this device and for the account, then the page
// reloads in the new language (lang.js). Each language keeps its own name (data-no-i18n).
import { lang, setLang } from './lang.js'

defineProps({ compact: { type: Boolean, default: false } })
const options = [['ko', '한국어'], ['en', 'English']]
</script>

<template>
  <div class="lang-switch" :class="{ compact }" role="group" aria-label="언어 / Language">
    <span v-if="!compact" class="lbl">언어 / Language</span>
    <div class="seg" data-no-i18n>
      <button v-for="[k, name] in options" :key="k" type="button" :class="{ on: lang === k }" :aria-pressed="lang === k" :data-lang="k" @click="setLang(k)">{{ name }}</button>
    </div>
  </div>
</template>

<style scoped>
.lang-switch { display: flex; align-items: center; gap: 10px; }
.lbl { font-size: 13px; color: var(--text-secondary); }
.seg { display: flex; padding: 2px; border-radius: 9999px; background: var(--cell-bg, rgba(127 127 127 / .14)); }
.seg button { height: 30px; padding: 0 12px; border-radius: 9999px; font-size: 13px; color: var(--text-secondary); }
.seg button.on { background: var(--ink, #1d1d1f); color: var(--ink-inverse, #fff); }
.compact .seg button { height: 28px; padding: 0 10px; font-size: 12px; }
</style>
