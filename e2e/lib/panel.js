// Panel apps with a fixed definition (no model): built in-process with the server's own service,
// exactly as the chat/Home path does after the model designed it. Cleaned up with remove + folder.
import { removeFolder } from './seed.js'

export async function makeApp(lib, owner, raw, { events = false, secure = true, rows = [] } = {}) {
  const P = await lib('lib/panelApps/service.js')
  let def
  if (events) def = (await lib('lib/panelApps/events.js')).normalizeEventsDef({ kind: 'events', ...raw }, { secure })
  else def = (await lib('lib/panelApps/sheet.js')).normalizeDef(raw, { strict: true })
  const who = { id: owner.id, name: `회귀-${owner.email.split('@')[0]}`, email: owner.email, jwt: owner.token() }
  const app = await P.createApp(who, { description: '', def, rows })
  const cleanup = async (db) => { await P.remove(who, app.id).catch(() => {}); await removeFolder(db, app.folder.slug) }
  return { app, def, cleanup, P, who }
}
export const addMember = (owner, slug, user, role = 'editor') => owner.post(`/folders/${slug}/members`, { type: 'user', id: user.id, role })
