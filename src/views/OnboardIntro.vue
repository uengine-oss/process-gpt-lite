<script setup>
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import Typewriter from '../components/Typewriter.vue'

const router = useRouter()
const lines = ['process gpt, 저는 당신만의 업무 운영체제처럼', '생각하시면 돼요.']
const step = ref(0)
const leaving = ref(false)

function next() {
  if (step.value < lines.length - 1) { setTimeout(() => step.value++, 250); return }
  setTimeout(() => { leaving.value = true }, 1400)
  setTimeout(() => router.replace('/chat?welcome=1'), 2300)
}
</script>

<template>
  <div class="intro" :class="{ leaving }">
    <p class="serif line">
      <i>process gpt,</i>
      <Typewriter :text="lines[0].replace('process gpt,', '')" :cps="16" :caret="step === 0" @done="next" />
    </p>
    <p class="serif line">
      <Typewriter v-if="step >= 1" :text="lines[1]" :cps="16" @done="next" />&nbsp;
    </p>
  </div>
</template>

<style scoped>
.intro { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  color: var(--text-primary); transition: opacity .9s, filter .9s; }
.intro.leaving { opacity: 0; filter: blur(10px); }
.line { margin: 0; font-size: clamp(24px, 3vw, 38px); line-height: 1.35; font-style: italic; font-weight: 300; letter-spacing: -0.01em; }
.line i { font-weight: 400; }
</style>
