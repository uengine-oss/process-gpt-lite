import { defineStore } from 'pinia'
import { api } from '../api.js'
import { useApp } from './app.js'
import { useSky } from './sky.js'

// 오늘의 배경 사진 (server lib/background): the day's photo candidates for Home's date · weather panel, and this person's choice.
// The choice lives on the server (pro_profile.background) so the phone, the desktop app and the web show the same; GET /api/me
// brings it at boot. Tapping a candidate shows it at once (preview) and then saves it; the sky is the default and the fallback.

// the person's own calendar date ('YYYY-MM-DD', their time zone)
export const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
// the photo a saved choice shows today, or null for the sky — the same rule as the server's (lib/background/prefs.js activePhoto)
export function activePhoto(pref, today) {
  if (!pref?.photo) return null
  if (pref.keep === 'always') return pref.photo
  return pref.day && pref.day === today ? pref.photo : null
}
export const MOODS = [
  { key: 'calm', label: '차분' }, { key: 'warm', label: '따뜻' }, { key: 'cool', label: '시원' }, { key: 'lively', label: '활기' },
]

export const useBackground = defineStore('background', {
  state: () => ({
    owner: null, // whose choice this is (the signed-in person's id)
    pref: null, // {photo, keep, day} as saved
    preview: null, // a photo just tapped, shown before the save comes back
    list: [], // the day's candidates (photos; the sky is the strip's first tile)
    day: null, // {date, term {name, start, today, next}, season {name}, part, weather}
    mood: null,
    keep: 'today', // for the next pick, and the current one's switch
    loading: false,
    loadedKey: '',
    loadingKey: '',
    again: false,
    error: '',
    failed: {}, // photo id -> true: its picture did not load (the sky stays)
  }),
  getters: {
    // the company's switch (Settings › 시스템 설정): GET /api/me features.background
    enabled() { return useApp().me?.features?.background !== false },
    // (sky.now ticks every 30s: midnight ends a "today only" choice while the page stays open)
    today() { return localDate(useSky().now) },
    saved() { return activePhoto(this.pref, this.today) },
    // what the strip marks as chosen
    current() { return this.enabled ? this.preview || this.saved : null },
    // what the background shows (null: the sky)
    photo() { const p = this.current; return p && !this.failed[p.id] ? p : null },
  },
  actions: {
    init(me) {
      this.owner = me?.user?.id || null
      this.pref = me?.profile?.background || null
      this.keep = this.pref?.keep || 'today'
    },
    clear() { this.$reset() },
    // the day's candidates for now: the date, the hour, the sun's altitude and the weather of the sky the screen draws
    async load({ force = false } = {}) {
      const sky = useSky()
      const now = new Date()
      const params = {
        date: this.today, hour: now.getHours(), alt: Math.round(sky.sun?.altitude ?? 30),
        wx: sky.wx?.code ?? '', mood: this.mood || '',
      }
      const key = JSON.stringify(params)
      // (asked while an answer is on its way: asked again once it is here, if the question changed)
      if (this.loading) { if (force || key !== this.loadingKey) this.again = true; return }
      if (!force && key === this.loadedKey) return
      this.loading = true
      this.loadingKey = key
      this.error = ''
      try {
        const r = await api(`/background/today?${new URLSearchParams(params)}`)
        this.loadedKey = key
        this.day = r.day || null
        this.list = r.candidates || []
        if (!this.preview) { this.pref = r.pref ?? null; if (this.pref?.keep) this.keep = this.pref.keep }
        // the company turned it off since this page opened: follow at once
        const app = useApp()
        if (app.me && (r.enabled === false) !== (app.me.features?.background === false)) app.me = { ...app.me, features: { ...(app.me.features || {}), background: r.enabled !== false } }
      } catch (e) {
        this.error = e.message || '추천을 불러오지 못했어요.'
      } finally {
        this.loading = false
        if (this.again) { this.again = false; this.load() }
      }
    },
    async pick(photo) {
      if (!photo) return this.toSky()
      const before = this.pref
      this.preview = photo
      this.error = ''
      const failed = { ...this.failed }
      delete failed[photo.id]
      this.failed = failed
      try {
        const r = await api('/background', { method: 'PUT', body: { photo, keep: this.keep, date: this.today } })
        this.pref = r.pref
      } catch (e) {
        this.pref = before
        this.error = e.message || '배경을 바꾸지 못했어요.'
      } finally {
        if (this.preview === photo) this.preview = null
      }
    },
    async toSky() {
      const before = this.pref
      this.preview = null
      this.pref = null
      this.error = ''
      try { await api('/background', { method: 'DELETE' }) } catch (e) { this.pref = before; this.error = e.message || '하늘로 돌리지 못했어요.' }
    },
    // 「오늘만」 · 「계속」: for the photo shown now (saved again with the new choice), and for the next pick
    async setKeep(keep) {
      if (keep === this.keep) return
      this.keep = keep
      const p = this.saved
      if (!p) return
      try {
        const r = await api('/background', { method: 'PUT', body: { photo: p, keep, date: this.today } })
        this.pref = r.pref
      } catch (e) { this.error = e.message || '바꾸지 못했어요.' }
    },
    setMood(m) {
      this.mood = this.mood === m ? null : m
      return this.load({ force: true })
    },
    // the picture did not load (the site is down, the file was removed): the sky stays, and the panel says so
    markFailed(id) { this.failed = { ...this.failed, [id]: true } },
  },
})
