<script setup>
// 프로필 사진 (Settings › 프로필, or the avatar at the top of Settings): Process GPT's preset pictures — saved as the same path its
// account settings save, so both apps show it — my own photo (made a 256 px square here, kept in my storage folder), or none
// (back to the default: the Google account's picture for someone signed in with Google, else the initial). The server checks
// what is saved and decides the default (server/routes/profilePicture.js).
import { ref, computed } from 'vue'
import Icon from './Icon.vue'
import PersonFace from './PersonFace.vue'
import { api, auth, refreshToken } from '../api.js'
import { BASE } from '../base.js'
import { useApp } from '../stores/app.js'
import { PRESETS, squareCrop } from '../profilePictures.js'
import { setPicture } from '../people.js'

const emit = defineEmits(['close'])
const app = useApp()
const busy = ref('')
const err = ref('')
const fileIn = ref(null)
const current = computed(() => app.me?.user?.picture || null)
// the default a cleared choice goes back to: the Google picture (signed in with Google), else none
const fallback = computed(() => app.me?.user?.pictureDefault || null)
const SIZE = 256
const MAX_FILE = 30 * 1024 * 1024

function applied(r) {
  if (app.me) app.me = { ...app.me, user: { ...app.me.user, picture: r.picture || null, pictureDefault: r.pictureDefault ?? app.me.user.pictureDefault ?? null } }
  setPicture(app.me?.user?.id, r.picture)
}
async function run(key, fn) {
  if (busy.value) return
  busy.value = key; err.value = ''
  try { applied(await fn()); emit('close') } catch (e) { err.value = e.message || '바꾸지 못했어요.' } finally { busy.value = '' }
}
const pick = (p) => (p === current.value ? emit('close') : run(p, () => api('/me/picture', { method: 'PUT', body: { picture: p } })))
const remove = () => run('remove', () => api('/me/picture', { method: 'PUT', body: { picture: null } }))

// the middle square of the photo, at most 256 px, as WebP (JPEG where the browser cannot write WebP); turned the way the camera held it
async function square(file) {
  let img, url
  try { img = await createImageBitmap(file) } catch {
    url = URL.createObjectURL(file)
    img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('decode')); i.src = url })
  }
  try {
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight
    const { sx, sy, s } = squareCrop(w, h)
    const out = Math.min(SIZE, s)
    const c = document.createElement('canvas')
    c.width = c.height = out
    const g = c.getContext('2d')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, out, out)
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, sx, sy, s, s, 0, 0, out, out)
    const webp = await new Promise((ok) => c.toBlob(ok, 'image/webp', 0.86))
    if (webp?.type === 'image/webp') return webp
    const jpg = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.88))
    if (!jpg) throw new Error('encode')
    return jpg
  } finally {
    img.close?.()
    if (url) URL.revokeObjectURL(url)
  }
}
async function send(blob) {
  const go = () => fetch(BASE + '/api/me/picture/upload', { method: 'POST', body: blob, headers: { 'Content-Type': blob.type, Authorization: `Bearer ${auth.get()?.session?.access_token || ''}` } })
  let r = await go()
  if (r.status === 401 && await refreshToken()) r = await go()
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(r.status === 413 ? '사진이 너무 커요. 다른 사진을 골라 주세요.' : j.error || '사진을 올리지 못했어요.')
  return j
}
async function chosen(e) {
  const file = e.target.files?.[0]
  e.target.value = ''
  if (!file) return
  if (file.type && !file.type.startsWith('image/')) { err.value = '사진 파일을 골라 주세요.'; return }
  if (file.size > MAX_FILE) { err.value = '30MB 보다 큰 사진은 올릴 수 없어요.'; return }
  await run('upload', async () => {
    let blob
    try { blob = await square(file) } catch { throw new Error('이 사진은 열 수 없어요. JPG · PNG · WebP 사진을 골라 주세요.') }
    return send(blob)
  })
}
</script>

<template>
  <div class="sheet-bg" @click.self="emit('close')">
    <div class="sheet glass" role="dialog" aria-label="프로필 사진" data-test="picture-sheet">
      <div class="h"><span>프로필 사진</span><button class="press" aria-label="닫기" data-test="picture-close" @click="emit('close')"><Icon name="close" :size="18" /></button></div>
      <p class="cap">기본 사진</p>
      <div class="grid">
        <button v-for="(p, i) in PRESETS" :key="p" class="pre press" :class="{ on: current === p, busy: busy === p }" :data-preset="p" :aria-label="`기본 사진 ${i + 1}`"
          :aria-pressed="current === p" :disabled="!!busy" @click="pick(p)"><PersonFace :picture="p" name="" /></button>
      </div>
      <div class="acts">
        <button class="pill-btn" data-test="picture-upload" :disabled="!!busy" @click="fileIn.click()">{{ busy === 'upload' ? '올리는 중…' : '내 사진 올리기' }}</button>
        <button v-if="current && current !== fallback" class="pill-btn quiet" data-test="picture-remove" :disabled="!!busy" @click="remove">{{ fallback ? 'Google 사진으로' : '사진 지우기' }}</button>
      </div>
      <p v-if="err" class="err" data-test="picture-error">{{ err }}</p>
      <p class="hint">Process GPT에도 같은 사진이 보여요.</p>
      <input ref="fileIn" type="file" accept="image/*" hidden data-test="picture-file" @change="chosen" />
    </div>
  </div>
</template>

<style scoped>
.sheet-bg { position: fixed; inset: 0; z-index: 45; display: grid; place-items: center; background: rgba(0 0 0 / .12); animation: fade-in .3s both; }
.sheet { width: min(420px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; border-radius: 28px; padding: 18px; display: flex; flex-direction: column; gap: 10px; box-shadow: var(--shadow-card); animation: pop-in .4s var(--spring) both; --regular-bg: var(--regular-solid-bg); }
.h { display: flex; justify-content: space-between; align-items: center; font-size: 17px; font-weight: 500; margin: 0 4px 2px; }
.cap { margin: 0 4px; font-size: 13px; color: var(--text-secondary); }
.grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; padding: 4px; }
.pre { aspect-ratio: 1; width: 100%; border-radius: 9999px; display: grid; place-items: center; overflow: hidden; background: var(--field-bg); color: var(--text-secondary); font-size: 14px; transition: box-shadow .2s; }
.pre.on { box-shadow: 0 0 0 2.5px var(--regular-solid-bg), 0 0 0 4.5px var(--ink); }
.pre.busy { opacity: .55; }
.pre:disabled { cursor: default; }
.acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.acts .pill-btn { height: 40px; padding: 0 16px; font-size: 14px; color: var(--text-primary); background: var(--field-bg); }
.acts .pill-btn:disabled { opacity: .5; cursor: default; }
.acts .quiet { color: var(--color-error); }
.err { margin: 0 4px; font-size: 13px; line-height: 1.45; color: var(--color-error); }
.hint { margin: 0 4px; font-size: 12.5px; color: var(--text-secondary); }
</style>
