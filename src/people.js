// Everyone's name and picture, by person id, for the circles and names that only know who (a teammate in the team list, a message's
// sender, a meeting tile): GET /api/people once a minute at most, asked for by the first circle that needs it — the server's one rule
// for who a person is (server/lib/people.js), so the same person has the same name and face on every screen. My own picture comes
// with /api/me (app.me.user.picture) and is put here when I change it.
import { reactive } from 'vue'
import { api, auth } from './api.js'

const pictures = reactive({})
const names = reactive({})
let loading = null
let loadedAt = 0

export function loadPeople({ force = false } = {}) {
  if (loading || (!force && Date.now() - loadedAt < 60_000)) return loading
  // (signed in only: an answer of 401 would send the page to the sign-in screen)
  if (!auth.get()?.session?.access_token) return null
  loading = api('/people')
    .then((r) => {
      for (const id of Object.keys(pictures)) if (!r[id]?.picture) delete pictures[id]
      for (const [id, p] of Object.entries(r || {})) {
        if (p?.picture) pictures[id] = p.picture
        if (p?.name) names[id] = p.name
      }
      loadedAt = Date.now()
    })
    .catch(() => { loadedAt = Date.now() })
    .finally(() => { loading = null })
  return loading
}
// (the name PR #60's circles called it by)
export const loadPictures = loadPeople

export const pictureOf = (id) => (id ? pictures[id] || null : null)
// the name the server gives this person, else the one the caller has (a row's own, before the list came)
export const nameOf = (id, fallback = '') => (id && names[id]) || fallback || ''

export function setPicture(id, picture) {
  if (!id) return
  if (picture) pictures[id] = picture
  else delete pictures[id]
}
export function setName(id, name) { if (id && name) names[id] = name }
