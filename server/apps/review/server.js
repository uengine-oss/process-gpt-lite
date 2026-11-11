// 검토 보드 (docs/robo-dlc/plan-review.md §3.1): what the folder's AI-DLC stage waits on — the open
// questions with the engine's recommendation and reason, and an approval's review findings — as cards
// split by role, reviewed by everyone at once (who is looking at what, stances, comments with
// evidence), then sent as one: answers into the question file, or one decision into the session's
// approval prompt. Uses the host context only (lib/apps/context.js).
import * as B from './board.js'

const err = (status, message) => Object.assign(new Error(message), { status })
const ALL_STANCES = new Set(['agree', 'choose', 'object', 'ask', 'accept', 'fix', 'reject'])

export default (ctx) => {
  const { q } = ctx.db
  const T = () => ctx.tenant()
  const L = ctx.L

  // ---------- the items of the stage ----------
  async function itemsOf(w) {
    const stage = w.stage
    const roleOf = (key) => key || stage?.roleKey || null
    const items = []
    if (!stage) return { items, files: [], review: null }
    const files = (await w.questions()).filter((f) => f.stage === stage.slug && (!w.unit || !f.unit || f.unit === w.unit.unit))
    for (const f of files) {
      for (const x of f.questions) {
        if (x.summary) continue
        items.push({
          key: B.questionKey(f.path, x), kind: 'question', file: f.path, id: x.id, tag: x.tag, followup: x.followup,
          text: x.text, note: x.note, options: x.options.map((o) => ({ key: o.key, text: o.text, rec: o.rec })),
          recommended: x.recommended, why: x.why, answer: x.answer, sent: !!x.answer, roleKey: roleOf(B.roleOfTag(x.tag)),
        })
      }
    }
    // an approval's findings: the stage's (and unit's) latest review, while its approval waits
    const session = await w.session()
    if (session.choice?.kind === 'approval') w.fresh()
    const reviews = (await w.reviews()).filter((r) => r.stage === stage.slug && (!w.unit || !r.unit || r.unit === w.unit.unit))
    const review = reviews.at(-1) || null
    if (review && session.choice?.kind === 'approval') {
      for (const f of review.findings) {
        const refs = await w.refs(f.location, stage.slug)
        // a finding about another stage's document is for that stage's role (requirements.md → PO)
        const refStage = refs[0] ? w.describeStage(refs[0].path.split('/')[refs[0].path.startsWith('construction/') ? 2 : 1]) : null
        items.push({
          key: B.findingKey(review.path, f), kind: 'finding', file: review.path, id: f.id, severity: f.severity, fileStatus: f.status,
          location: f.location, refs, text: f.finding, action: f.action, sent: false, roleKey: roleOf(refStage?.roleKey),
        })
      }
    }
    return { items, files, review, session }
  }

  // people of each role (no one in a role: the stage's deciders — its owners)
  async function lanes(w, items) {
    const out = new Map()
    for (const it of items) {
      if (out.has(it.roleKey)) continue
      let people = it.roleKey ? await w.holders(it.roleKey) : []
      if (!people.length) people = await w.deciders(w.stage?.roleKey)
      out.set(it.roleKey, { roleKey: it.roleKey, role: it.roleKey ? w.roleName(it.roleKey) : L('담당', 'Owner'), people })
    }
    return [...out.values()]
  }

  async function board(slug, user) {
    const w = await ctx.aidlc.open(slug, user)
    const { items, review, session } = await itemsOf(w)
    const keys = items.map((i) => i.key)
    const fid = w.folder.id
    const WHO = `coalesce(p.name, u.username, u.email)`
    const marks = keys.length ? await q(`select m.item_key, m.user_id, m.stance, m.choice, m.note, m.updated_at, ${WHO} as name from app_review_marks m
      left join users u on u.id = m.user_id and u.tenant_id = m.tenant_id left join pro_profile p on p.user_id = m.user_id
      where m.tenant_id=$1 and m.folder_id=$2 and m.item_key = any($3) order by m.updated_at`, [T(), fid, keys]) : []
    const comments = keys.length ? await q(`select c.id, c.item_key, c.user_id, c.body, c.evidence, c.created_at, ${WHO} as name from app_review_comments c
      left join users u on u.id = c.user_id and u.tenant_id = c.tenant_id left join pro_profile p on p.user_id = c.user_id
      where c.tenant_id=$1 and c.folder_id=$2 and c.item_key = any($3) order by c.created_at`, [T(), fid, keys]) : []
    const ls = await lanes(w, items)
    const reviewersOf = new Map(ls.map((l) => [l.roleKey, new Set(l.people.map((p) => p.id))]))
    const out = items.map((it) => {
      const st = B.itemState(it, marks, reviewersOf.get(it.roleKey) || new Set())
      return { ...it, state: st.state, decision: st.decision, doubts: st.doubts, marks: marks.filter((m) => m.item_key === it.key), comments: comments.filter((c) => c.item_key === it.key) }
    })
    const stageRole = w.stage?.roleKey || null
    return {
      folder: w.folder, intent: w.intent, stage: w.stage, unit: w.unit,
      me: { id: user.id, name: user.name, canSend: await w.mayDecide(stageRole), reviews: ls.filter((l) => l.people.some((p) => p.id === user.id)).map((l) => l.roleKey) },
      lanes: ls, items: out, presence: presenceOf(fid),
      review: review && { path: review.path, verdict: review.verdict, iteration: review.iteration },
      prompt: session?.choice ? { kind: session.choice.kind, title: session.choice.title, fingerprint: session.choice.fingerprint } : null,
      deciders: await w.deciders(stageRole), workroom: session?.workroom,
    }
  }

  // ---------- who is looking at what (memory only: it is live or it is nothing) ----------
  const seen = new Map() // folderId -> Map(userId -> { name, key, at })
  const LIVE = 15000
  function presenceOf(fid) {
    const m = seen.get(fid)
    if (!m) return []
    const now = Date.now()
    for (const [id, p] of m) if (now - p.at > LIVE) m.delete(id)
    return [...m.entries()].map(([id, p]) => ({ id, name: p.name, key: p.key, age: now - p.at }))
  }
  const changed = (folder, data = {}) => ctx.events.toFolder(folder, 'changed', data)

  // the cards for one item, by its key (and it must be one of the stage's now)
  async function itemFor(w, key) {
    const { items, session } = await itemsOf(w)
    const it = items.find((i) => i.key === key)
    if (!it) throw err(404, 'not an item of this stage (it may have moved on)')
    return { it, session }
  }

  return {
    routes(r) {
      r.get('/:folder/board', (req) => board(req.params.folder, req.user))

      // my stance on an item: a reviewer decides (agree / choose · accept / fix / reject); anyone may doubt (object / ask)
      r.post('/:folder/mark', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const { key, stance, choice = null, note = null } = req.body || {}
        if (!ALL_STANCES.has(stance)) throw err(400, 'unknown stance')
        const { it } = await itemFor(w, String(key || ''))
        if (it.sent) throw err(409, L('이미 보낸 항목이에요.', 'Already sent.'))
        const decides = it.kind === 'question' ? ['agree', 'choose'] : ['accept', 'fix', 'reject']
        if (it.kind === 'question' && ['accept', 'fix', 'reject'].includes(stance)) throw err(400, 'not a stance on a question')
        if (it.kind === 'finding' && ['agree', 'choose', 'ask'].includes(stance)) throw err(400, 'not a stance on a finding')
        if (decides.includes(stance)) {
          let people = it.roleKey ? await w.holders(it.roleKey) : []
          if (!people.length) people = await w.deciders(w.stage?.roleKey)
          if (!people.some((p) => p.id === req.user.id) && !w.canEdit) throw err(403, L('이 카드는 담당 역할의 사람이 정해요. 이의·질문은 누구나 달 수 있어요.', 'The person in the role decides this card; anyone can object or ask.'))
        }
        if (stance === 'choose' && !(it.options || []).some((o) => o.key === choice)) throw err(400, 'no such option')
        if ((stance === 'choose' && choice === 'X') || ['object', 'ask', 'fix', 'reject'].includes(stance)) {
          if (!String(note || '').trim()) throw err(400, L('이유를 적어 주세요.', 'Say why.'))
        }
        await q(`insert into app_review_marks(tenant_id,folder_id,item_key,user_id,stance,choice,note,updated_at) values ($1,$2,$3,$4,$5,$6,$7,now())
                 on conflict (tenant_id,folder_id,item_key,user_id) do update set stance=excluded.stance, choice=excluded.choice, note=excluded.note, updated_at=now()`,
          [T(), w.folder.id, it.key, req.user.id, stance, stance === 'choose' ? choice : null, note ? String(note).slice(0, 1000) : null])
        await changed(w.folder, { key: it.key, by: req.user.name, stance })
        return { ok: true }
      })

      // a comment, with evidence: a part of a record document, or a link
      r.post('/:folder/comment', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const { key, body, evidence = [] } = req.body || {}
        if (!String(body || '').trim()) throw err(400, 'empty')
        const { it } = await itemFor(w, String(key || ''))
        const docs = new Set((await w.docs()).map((d) => d.path))
        const ev = []
        for (const e of (Array.isArray(evidence) ? evidence : []).slice(0, 6)) {
          if (e?.path && docs.has(e.path)) ev.push({ path: e.path, focus: String(e.focus || '').slice(0, 200), label: String(e.label || e.path).slice(0, 200), snippet: String(e.snippet || '').slice(0, 300) })
          else if (e?.url && /^https?:\/\//.test(e.url)) ev.push({ url: String(e.url).slice(0, 500), label: String(e.label || e.url).slice(0, 200) })
        }
        const [c] = await q(`insert into app_review_comments(tenant_id,folder_id,item_key,user_id,body,evidence) values ($1,$2,$3,$4,$5,$6) returning id`,
          [T(), w.folder.id, it.key, req.user.id, String(body).slice(0, 2000), JSON.stringify(ev)])
        await changed(w.folder, { key: it.key, by: req.user.name, comment: c.id })
        return { id: c.id }
      })

      // where the evidence for an item may be: the places a finding names, then lines of the record
      // that hold the item's words (no model — fast, and every hit is a quote with its place)
      r.post('/:folder/evidence', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const { it } = await itemFor(w, String(req.body?.key || ''))
        const list = await w.docs()
        const skip = (p) => /-questions\.md$|\/memory\.md$|\/reviews\/|^aidlc-state\.md$/.test(p)
        const docs = []
        for (const d of list.filter((x) => !skip(x.path)).slice(0, 120)) docs.push(await w.readDoc(d.path).catch(() => ({ path: d.path, text: '' })))
        const terms = B.termsOf(it.kind === 'question' ? `${it.text} ${it.note || ''} ${(it.options || []).filter((o) => o.key !== 'X').map((o) => o.text).join(' ')}` : `${it.text} ${it.action || ''}`)
        const named = (it.refs || []).map((r) => ({ ...r, snippet: '', named: true }))
        return { terms, hits: [...named, ...B.searchDocs(docs, terms, { limit: 6 })].slice(0, 8) }
      })

      // I am looking at the board (key null) or at one card; sent every few seconds while it is open
      r.post('/:folder/presence', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const fid = w.folder.id
        if (!seen.has(fid)) seen.set(fid, new Map())
        if (req.body?.leave) seen.get(fid).delete(req.user.id)
        else seen.get(fid).set(req.user.id, { name: req.user.name, key: req.body?.key ? String(req.body.key).slice(0, 400) : null, at: Date.now() })
        const list = presenceOf(fid)
        await ctx.events.toFolder(w.folder, 'presence', { users: list })
        return { users: list }
      })

      // the cards in dispute, put to the folder's mob meeting (only those questions)
      r.post('/:folder/mob', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        const b = await board(req.params.folder, req.user)
        const only = b.items.filter((i) => i.kind === 'question' && i.state === 'discuss').map((i) => i.id)
        const out = await w.mob({ only: only.length ? only : undefined })
        await changed(w.folder, { mob: out.roomId })
        return { ...out, questions: only }
      })

      // Send it all as one (the stage's decider): the questions' answers into their file (the session is
      // told), or the findings as one decision into the approval prompt on the session's screen.
      r.post('/:folder/send', async (req) => {
        const w = await ctx.aidlc.open(req.params.folder, req.user)
        if (!(await w.mayDecide(w.stage?.roleKey))) throw err(403, L('보내기는 이 단계의 담당자나 폴더 편집 권한이 있는 사람이 해요.', 'The stage’s decider (or a folder editor) sends.'))
        const { what, useRecommended = false, force = false } = req.body || {}
        const b = await board(req.params.folder, req.user)
        if (what === 'questions') {
          const files = [...new Set(b.items.filter((i) => i.kind === 'question' && !i.sent).map((i) => i.file))]
          if (!files.length) throw err(409, L('보낼 질문이 없어요.', 'No question to send.'))
          const file = req.body?.file && files.includes(req.body.file) ? req.body.file : files[0]
          const mine = b.items.filter((i) => i.kind === 'question' && !i.sent && i.file === file)
          const inDispute = mine.filter((i) => i.state === 'discuss')
          if (inDispute.length && !force) throw err(409, L(`논의가 끝나지 않은 질문이 ${inDispute.length}개 있어요: ${inDispute.map((i) => i.id).join(', ')}`, `${inDispute.length} question(s) still in dispute: ${inDispute.map((i) => i.id).join(', ')}`))
          const answers = {}
          const missing = []
          for (const it of mine) {
            const a = B.answerOf(it, it.decision, { useRecommended })
            if (a) answers[it.id] = a
            else missing.push(it.id)
          }
          if (missing.length) throw err(409, L(`아직 정하지 않은 질문: ${missing.join(', ')} — AI 추천대로 보내려면 「추천대로 채워 보내기」`, `Not decided yet: ${missing.join(', ')} — use "send, recommended for the rest"`))
          const out = await w.answers({ path: file, answers })
          await changed(w.folder, { sent: 'questions', file })
          return { sent: 'questions', file, answers: out.written, told: out.told }
        }
        if (what === 'findings') {
          if (b.prompt?.kind !== 'approval') throw err(409, L('세션 화면에 승인 창이 없어요.', 'No approval prompt on the session screen.'))
          const findings = b.items.filter((i) => i.kind === 'finding')
          const open = findings.filter((i) => i.state === 'open' && !useRecommended)
          if (open.length) throw err(409, L(`아직 정하지 않은 지적: ${open.map((i) => i.id).join(', ')}`, `Findings not decided: ${open.map((i) => i.id).join(', ')}`))
          const inDispute = findings.filter((i) => i.state === 'discuss')
          if (inDispute.length && !force) throw err(409, L(`논의가 끝나지 않은 지적이 있어요: ${inDispute.map((i) => i.id).join(', ')}`, `Findings still in dispute: ${inDispute.map((i) => i.id).join(', ')}`))
          const states = new Map(findings.map((i) => [i.key, { decision: i.decision }]))
          const d = B.composeApproval(findings, states, { lang: ctx.isEn() ? 'en' : 'ko' })
          const s = await w.session()
          const opts = s.choice?.options || []
          const opt = d.action === 'approve' ? opts.find((o) => /^Approve\b/i.test(o.label)) : opts.find((o) => o.freeText)
          if (!opt) throw err(409, 'the approval prompt has no option for this')
          const out = await w.decide({ fingerprint: s.choice.fingerprint, option: opt.n, text: opt.freeText ? d.text : undefined })
          await changed(w.folder, { sent: 'findings' })
          return { sent: 'findings', action: d.action, text: d.text, answered: out.answered }
        }
        throw err(400, 'what: questions | findings')
      })
    },

    // the watcher found a wait this app handles (manifest "handles"): besides the stage's decider (told
    // already), each person whose cards are in it gets one card with their own count
    waits: {
      // questions always; an approval only when its stage has review findings to split (else the decision page)
      async accepts(folder, wait) {
        if (wait.kind === 'questions') return true
        const w = await ctx.aidlc.system(folder.slug)
        return (await itemsOf(w)).items.some((i) => i.kind === 'finding')
      },
      async notify(folder, wait, url, told) {
        const w = await ctx.aidlc.system(folder.slug)
        const { items } = await itemsOf(w)
        const open = items.filter((i) => !i.sent)
        if (!open.length) return
        const byRole = new Map()
        for (const it of open) byRole.set(it.roleKey, [...(byRole.get(it.roleKey) || []), it])
        for (const [roleKey, list] of byRole) {
          const people = roleKey ? await w.holders(roleKey) : []
          for (const p of people) {
            if (!p.id || told.has(p.id)) continue
            told.add(p.id)
            const what = list[0].kind === 'question' ? L(`검토할 질문 ${list.length}개`, `${list.length} question(s) to review`) : L(`검토할 지적 ${list.length}개`, `${list.length} finding(s) to review`)
            await ctx.notify(p.id, { title: `${folder.name} · ${w.stage.name} — ${what} (${w.roleName(roleKey)})`, text: list.map((i) => `${i.id}. ${i.text}`).join(' / ').slice(0, 300), url })
          }
        }
      },
    },
  }
}
