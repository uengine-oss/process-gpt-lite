import { defineStore } from 'pinia'
import { sunPosition, moonPhase } from '../sky/solar.js'
import { computePalette, conditionProfile } from '../sky/palette.js'
import { locate, weather, savePlace, preciseLocation } from '../sky/weather.js'

// Owns place, weather, the (optionally simulated) clock and the resulting palette.
// Also flips <html data-theme> between light and dark with the sun.
export const useSky = defineStore('sky', {
  state: () => ({
    place: null,
    wx: null,
    simHour: null,          // number 0..24 to preview another time of day
    themePref: 'auto',      // auto | light | dark
    now: new Date(),
  }),
  getters: {
    clock(s) {
      if (s.simHour == null) return s.now
      const d = new Date(s.now)
      d.setHours(Math.floor(s.simHour), Math.round((s.simHour % 1) * 60), 0, 0)
      return d
    },
    sun() {
      const p = this.place || { lat: 37.57, lon: 126.98 }
      return sunPosition(this.clock, p.lat, p.lon)
    },
    // the sun the sky is drawn with: the real one, unless the person chose a theme the hour disagrees with. A light theme at night (or
    // at dusk, when the top of the sky is already dark) draws a morning sky, a dark theme by day an evening one — the page's titles sit
    // on the sky with the chosen theme's ink, so the sky has to match it (11-27: 「계정」 · 「영업 자료」 dark on the night sky)
    shownSun() {
      const s = this.sun
      if (this.themePref === 'light' && s.altitude < 10) return { ...s, altitude: 20 }
      if (this.themePref === 'dark' && s.altitude > -6) return { ...s, altitude: -14 }
      return s
    },
    palette() {
      return computePalette({
        altitude: this.shownSun.altitude,
        cloudCover: this.wx?.cloud ?? 25,
        weatherCode: this.wx?.code ?? 1,
        moon: moonPhase(this.clock),
      })
    },
    isDay() {
      if (this.themePref !== 'auto') return this.themePref === 'light'
      return this.palette.isDay
    },
    condition() { return conditionProfile(this.wx?.code).label },
  },
  actions: {
    async init() {
      const qs = new URLSearchParams(location.search)
      if (qs.has('hour')) this.simHour = Number(qs.get('hour'))
      try { this.themePref = localStorage.getItem('pgpt-pro-theme') || 'auto' } catch { /* ignore */ }
      this.place = await locate()
      this.refresh()
      setInterval(() => { this.now = new Date(); this.applyTheme() }, 30000)
      setInterval(() => this.refresh(), 15 * 60000)
      this.applyTheme()
    },
    async refresh() {
      try { this.wx = await weather(this.place) } catch { /* keep last */ }
    },
    async sharePrecise() {
      this.place = await preciseLocation()
      savePlace(this.place)
      await this.refresh()
    },
    setTheme(pref) {
      this.themePref = pref
      try { localStorage.setItem('pgpt-pro-theme', pref) } catch { /* ignore */ }
      this.applyTheme()
    },
    setSim(h) { this.simHour = h; this.applyTheme() },
    applyTheme() {
      const t = this.isDay ? 'light' : 'dark'
      document.documentElement.dataset.theme = t
    },
  },
})
