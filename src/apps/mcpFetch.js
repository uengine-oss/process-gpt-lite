// fetch for an MCP client talking to this server as the signed-in person: a fresh token on every request.
// (The transport passes its headers as a Headers object: Accept and Content-Type must stay.)
import { freshToken } from '../api.js'

export async function authedFetch(url, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${await freshToken()}`)
  return fetch(url, { ...init, headers })
}
