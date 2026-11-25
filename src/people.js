// Everyone's name and picture, by person id, for the circles and names that only know who (a teammate in the team list, a message's
// sender, a meeting tile): GET /api/people once a minute at most, asked for by the first circle that needs it — the server's one rule
// for who a person is (server/lib/people.js), so the same person has the same name and face on every screen. My own picture comes
// with /api/me (app.me.user.picture) and is put here when I change it.
import { reactive } from 'vue'
import { api, auth } from './api.js'
import { nameTags, tagged } from './sameNames.js'

const pictures = reactive({})
const names = reactive({})
const emails = reactive({})
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
        if (p?.email) emails[id] = p.email
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

export const emailOf = (id) => (id && emails[id]) || ''

// Same-named people in one list, told apart (src/sameNames.js): list [{id, name, email?}] → Map id → tag. The name every screen uses
// and, where the row has none, the address from the list above. tagOf(tags, p): what to show — the name, then 「 · tag」 when needed.
export const tagsFor = (list) => nameTags((list || []).filter(Boolean).map((p) => ({ id: p.id, name: nameOf(p.id, p.name), email: p.email || emailOf(p.id) })))
export const labelOf = (tags, p, name) => tagged(name ?? nameOf(p?.id, p?.name), tags?.get(String(p?.id ?? '')) || '')

export function setPicture(id, picture) {
  if (!id) return
  if (picture) pictures[id] = picture
  else delete pictures[id]
}
export function setName(id, name) { if (id && name) names[id] = name }
