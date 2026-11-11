// Lite apps the server has (lib/apps/registry.js) and the one open beside the current screen.
import { defineStore } from 'pinia'
import { api } from '../api.js'

export const useApps = defineStore('apps', {
  state: () => ({ list: null, sheet: null }), // sheet: { id, folder, params }
  getters: {
    byId: (s) => (id) => (s.list || []).find((a) => a.id === id) || null,
  },
  actions: {
    async load(force = false) {
      if (this.list && !force) return this.list
      this.list = await api('/apps').catch(() => [])
      return this.list
    },
    // the apps that apply to a folder (an AI-DLC folder gets the AI-DLC apps)
    forFolder: (slug) => api(`/apps/for/${encodeURIComponent(slug)}`).catch(() => []),
    async open(id, folder, params = {}) {
      await this.load()
      if (!this.byId(id)) return false
      this.sheet = { id, folder, params }
      return true
    },
    close() { this.sheet = null },
  },
})
