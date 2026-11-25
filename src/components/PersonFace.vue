<script setup>
// A person's face inside the round avatar it is put in (the circle keeps its own size, colour and font): their picture, cover-fit
// to the circle's shape, or their initial — when they have none, or when it does not load. picture: given (mine: app.me.user.picture,
// null = none); otherwise looked up by id (src/people.js). A Process GPT preset is tried at the site's root first, then Lite's copy.
// No referrer goes with it (a Google account's picture is served only without one; nothing else needs it).
import { ref, computed, watch, onMounted } from 'vue'
import { BASE } from '../base.js'
import { faceSources, initialOf } from '../profilePictures.js'
import { pictureOf, loadPictures } from '../people.js'

const props = defineProps({ name: String, picture: { type: String, default: undefined }, id: String })
const src = computed(() => (props.picture !== undefined ? props.picture : pictureOf(props.id)))
const tries = computed(() => faceSources(src.value, BASE))
const at = ref(0)
watch(() => tries.value.join('\n'), () => { at.value = 0 })
const url = computed(() => tries.value[at.value] || '')
onMounted(() => { if (props.picture === undefined && props.id) loadPictures() })
</script>

<template>
  <img v-if="url" :key="url" class="face" :src="url" alt="" draggable="false" referrerpolicy="no-referrer" data-test="face" @error="at++" />
  <template v-else>{{ initialOf(name) }}</template>
</template>

<style scoped>
.face { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: inherit; outline: 1px solid rgba(0 0 0 / .08); outline-offset: -1px; pointer-events: none; user-select: none; }
:root[data-theme="dark"] .face { outline-color: rgba(255 255 255 / .14); }
</style>
