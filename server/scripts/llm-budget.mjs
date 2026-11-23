// Model budgets per company and person, kept by LiteLLM (PRO_LLM_KEYS=litellm, lib/llmKeys.js). Amounts in USD.
//   node scripts/llm-budget.mjs status <tenant>                          this month: company, features, people
//   node scripts/llm-budget.mjs set <tenant> --budget 50 [--duration 30d]  the company's budget (team max_budget)
//   node scripts/llm-budget.mjs member <tenant> <email|user-id> --budget 5  one person's limit in that company
import { config } from '../config.js'
import { q, pool } from '../lib/supa.js'
import { teamOf } from '../lib/llmKeys.js'
import { monthOf } from '../lib/llmUsage.js'

const [cmd, tenant, ...rest] = process.argv.slice(2)
const opt = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined }
const print = (o) => console.log(JSON.stringify(o, null, 2))

async function admin(path, body) {
  const res = await fetch(`${config.llmKeys.adminUrl}${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.llmKeys.adminKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok && !((res.status === 400 || res.status === 409) && /already|exist/i.test(text))) throw new Error(`LiteLLM ${path} ${res.status}: ${text.slice(0, 200)}`)
  return text
}

try {
  if (!tenant) throw new Error('usage: status|set|member <tenant> …')
  switch (cmd) {
    case 'status': print(await monthOf(tenant, { people: true })); break
    case 'set': {
      const budget = Number(opt('budget'))
      if (!(budget >= 0)) throw new Error('--budget <usd>')
      await admin('/team/new', { team_id: teamOf(tenant), team_alias: tenant, metadata: { tenant } })
      await admin('/team/update', { team_id: teamOf(tenant), max_budget: budget, budget_duration: opt('duration') || '30d' })
      print((await monthOf(tenant)).budget)
      break
    }
    case 'member': {
      const who = rest[0], budget = Number(opt('budget'))
      if (!who || !(budget >= 0)) throw new Error('usage: member <tenant> <email|user-id> --budget <usd>')
      const [p] = await q('select user_id::text id from pro_profile where email=$1 or user_id::text=$1', [who])
      if (!p) throw new Error(`no person ${who}`)
      // a person who has not called a model yet is not a member yet (lib/llmKeys.js adds them on the first call)
      await admin('/team/new', { team_id: teamOf(tenant), team_alias: tenant, metadata: { tenant } })
      await admin('/user/new', { user_id: p.id, auto_create_key: false })
      await admin('/team/member_add', { team_id: teamOf(tenant), member: { role: 'user', user_id: p.id } })
      await admin('/team/member_update', { team_id: teamOf(tenant), user_id: p.id, max_budget_in_team: budget })
      print((await monthOf(tenant, { people: true })).people.find((x) => x.user_id === p.id) || { user_id: p.id, limit: budget, note: 'no calls yet this month' })
      break
    }
    default: throw new Error(`unknown command ${cmd}`)
  }
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
