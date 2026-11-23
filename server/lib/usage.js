// Who a model call is for: the signed-in person of a request (index.js auth), or the person background work
// is for (asUser in lib/lang.js), and what it is for (a feature tag). lib/llmKeys.js charges the call to them.
import { AsyncLocalStorage } from 'node:async_hooks'

const store = new AsyncLocalStorage()
export const usage = () => store.getStore() || {}
export const withUsage = (ctx, fn) => store.run({ ...usage(), ...ctx }, fn)

// the feature a request's model calls count under, from its path (/api/<area>/…)
const AREAS = {
  threads: 'chat', conversations: 'chat', messages: 'chat', choices: 'chat', actions: 'chat', search: 'chat',
  browser: 'browser', vault: 'browser', panels: 'panel_app', 'panel-ask': 'panel_app', 'panel-proxy': 'panel_app',
  missions: 'mission', schedules: 'mission', cron: 'mission', skills: 'skill', 'skill-drafts': 'skill',
  mail: 'mail', meetings: 'meeting', team: 'team', reviews: 'process', roles: 'process', workroom: 'workroom',
  folders: 'knowledge', mining: 'mining', improve: 'improve', office: 'office_doc', craft: 'craft',
}
export const featureOf = (path) => AREAS[String(path || '').split('/')[2]] || 'other'
