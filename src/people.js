// Everyone's picture, by person id, for the circles that only know who (a teammate in the team list, a message's sender, a
// meeting tile): GET /api/people/pictures once a minute at most, asked for by the first circle that needs it. My own comes
// with /api/me (app.me.user.picture) and is put here when I change it.
import { reactive } from 'vue'
import { api, auth } from './api.js'

const pictures = reactive({})
let loading = null
let loadedAt = 0

export function loadPictures({ force = false } = {}) {
  if (loading || (!force && Date.now() - loadedAt < 60_000)) return loading
  // (signed in only: an answer of 401 would send the page to the sign-in screen)
  if (!auth.get()?.session?.access_token) return null
  loading = api('/people/pictures')
    .then((r) => {
      for (const id of Object.keys(pictures)) if (!(id in r)) delete pictures[id]
      Object.assign(pictures, r)
      loadedAt = Date.now()
    })
    .catch(() => { loadedAt = Date.now() })
    .finally(() => { loading = null })
  return loading
}

export const pictureOf = (id) => (id ? pictures[id] || null : null)

export function setPicture(id, picture) {
  if (!id) return
  if (picture) pictures[id] = picture
  else delete pictures[id]
}
