// A case's run view (server lib/ontology/runmode.js runView — GET /ontology/cases/:id/run), read once per case however many places
// show it: the map's case panel shows all of it in one OntoCaseRun; a map case's instance page shows its controls (방식 · 멈추기 ·
// 기다리는 단계) under the flowchart and its steps in the 「목록」 view — two OntoCaseRun parts over one reading, one poll.
// Each user takes it (acquire) and lets it go (release); the poll stops when nobody shows the case.
import { ref } from 'vue'
import { api } from '../../api.js'

const live = new Map() // caseId → { run, err, users, timer, load }

export function acquire(caseId) {
  const id = String(caseId)
  let s = live.get(id)
  if (!s) {
    s = { id, run: ref(null), err: ref(''), users: 0, timer: 0 }
    s.load = async () => {
      try { s.run.value = await api(`/ontology/cases/${encodeURIComponent(id)}/run`); s.err.value = '' } catch (e) { s.err.value = e.message }
      clearTimeout(s.timer)
      if (s.users > 0) s.timer = setTimeout(s.load, s.run.value?.status === 'running' ? 4000 : 15000)
    }
    live.set(id, s)
    s.users++
    s.load()
    return s
  }
  s.users++
  return s
}

export function release(s) {
  if (!s) return
  s.users--
  if (s.users > 0) return
  clearTimeout(s.timer)
  if (live.get(s.id) === s) live.delete(s.id)
}
