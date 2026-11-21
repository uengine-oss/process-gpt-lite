// The action skills, checked against this server's tables: every handler, fact and state condition a
// skill names must exist (lib/skills/handlers.js, facts.js), or the server does not start.
import { useValidator, problemsOf, actionSkills } from './registry.js'
import { HANDLERS } from './handlers.js'
import { FACT_NAMES, CONDITIONS } from './facts.js'

let ready = false
export function startActionSkills() {
  if (!ready) { useValidator((skills) => problemsOf(skills, { handlers: HANDLERS, facts: FACT_NAMES, conditions: CONDITIONS })); ready = true }
  return actionSkills()
}
