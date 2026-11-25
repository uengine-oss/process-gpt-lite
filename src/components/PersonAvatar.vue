<script setup>
// One round face for a person, everywhere in the app (2026-11-25 「일관성있는 컴포넌트 사용이 되어야」): the circle, their picture or
// initial (PersonFace — the name and picture the server gives every screen, src/people.js), a size, and for what their agent did a
// small ✦ at the corner — the owner's face with the agent's mark, not a letter of its own.
//   size: xs 20 · sm 28 · md 34 · lg 44, a number of pixels, or 'fill' (the box it is put in)
//   kind: person (a face) · ai (the room's AI, ✦) · group (a member count, the slot) · role (a role, #) — one base style for all
//   agent: the person's agent did it (the ✦ mark)   color: a background of the place's own (the shared folders' colours)
import { computed } from 'vue'
import PersonFace from './PersonFace.vue'

const props = defineProps({
  id: { type: String, default: undefined },
  name: { type: String, default: '' },
  picture: { type: String, default: undefined },
  size: { type: [String, Number], default: 'md' },
  kind: { type: String, default: 'person' },
  agent: Boolean,
  color: { type: String, default: '' },
})
const SIZES = { xs: 20, sm: 28, md: 34, lg: 44 }
const px = computed(() => (props.size === 'fill' ? 0 : Number(SIZES[props.size] ?? props.size) || SIZES.md))
const box = computed(() => (px.value ? { '--pav-s': `${px.value}px`, '--pav-f': `${Math.max(10, Math.round(px.value * 0.42))}px` } : null))
</script>

<template>
  <span class="pav" :class="[`k-${kind}`, { fill: !px, marked: agent }]" :style="box" data-test="person-avatar" :data-kind="kind"
    :data-person="kind === 'person' ? id || null : null" :data-agent="agent ? '' : null">
    <span class="c" :style="color ? { background: color } : null">
      <PersonFace v-if="kind === 'person'" :id="id" :name="name" :picture="picture" />
      <template v-else-if="kind === 'ai'">✦</template>
      <template v-else-if="kind === 'role'">#</template>
      <slot v-else />
    </span>
    <i v-if="agent" class="mark" data-test="agent-badge" aria-hidden="true">✦</i>
  </span>
</template>

<style scoped>
.pav { position: relative; flex: none; display: inline-grid; width: var(--pav-s, 34px); height: var(--pav-s, 34px); vertical-align: middle; }
.pav.fill { width: 100%; height: 100%; }
.c { display: grid; place-items: center; width: 100%; height: 100%; overflow: hidden; border-radius: 9999px; color: #fff; font-weight: 600; font-style: normal;
  font-size: var(--pav-f, 14px); line-height: 1; background: linear-gradient(135deg, #8aa6d8, #4a5f9a); user-select: none; }
.pav.fill .c { font-size: inherit; }
.k-ai .c { background: linear-gradient(135deg, #7a5af5, #2a78d6); }
.k-group .c { background: #0f8a5f; }
.k-role .c { background: #0f8a5f; border-radius: 30%; }
/* the agent's mark: a small ✦ on the owner's face, ringed in the surface it sits on */
.mark { position: absolute; right: -3px; bottom: -3px; width: max(13px, 44%); height: max(13px, 44%); border-radius: 9999px; display: grid; place-items: center;
  font-style: normal; font-size: max(8px, calc(var(--pav-s, 34px) * .26)); line-height: 1; color: #fff; background: linear-gradient(135deg, #7a5af5, #2a78d6);
  box-shadow: 0 0 0 2px var(--regular-solid-bg, #fff); pointer-events: none; }
</style>
