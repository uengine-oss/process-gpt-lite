// 일이 쓰는 양식 · 형식 규칙 · 스킬 보기 · 건의 단계가 만든 파일(lib/ontology/formats.js · stepdoc.js) — routes/ontology.js 가 붙인다.
// 보기는 누구나(메일 제목 · 파일 이름 · 링크는 그 메일함 주인만), 양식 파일 열기는 메일함 주인이나 관리자, 고르기 · 형식 규칙 찾기 · 고치기는 관리자.
// hl: h for a route that waits on model calls for minutes (routes/ontology.js — lib/longJson.js)
export function formRoutes(r, { auth, h, hl = h, admin }) {
  const F = () => import('../lib/ontology/formats.js')
  const form = (req) => String(req.body?.form ?? req.query.form ?? '')
  r.get('/ontology/tasks/:key/forms', auth, h(async (req) => (await F()).formsView(req.user, req.params.key)))
  r.put('/ontology/tasks/:key/form', auth, h(async (req) => { await admin(req); return (await F()).chooseForm(req.user, req.params.key, { form: req.body?.form ? String(req.body.form) : null, ofTask: req.body?.ofTask ? String(req.body.ofTask) : null, keys: Array.isArray(req.body?.keys) ? req.body.keys.map(String).slice(0, 12) : null }) }))
  r.get('/ontology/forms/company', auth, h(async (req) => { await admin(req); return { forms: await (await F()).companyForms(String(req.query.except || '')) } }))
  r.post('/ontology/tasks/:key/forms/open', auth, h(async (req) => (await F()).openForm(req.user, req.params.key, form(req))))
  r.get('/ontology/tasks/:key/forms/format', auth, h(async (req) => (await F()).formatView(req.user, req.params.key, form(req))))
  r.post('/ontology/tasks/:key/forms/format', auth, hl(async (req) => { await admin(req); return (await F()).mineFormat(req.user, req.params.key, form(req), { fetchMail: req.body?.fetchMail !== false }) }))
  r.put('/ontology/tasks/:key/forms/format', auth, h(async (req) => { await admin(req); return (await F()).saveFormat(req.user, req.params.key, form(req), { items: Array.isArray(req.body?.items) ? req.body.items : null, skill_md: typeof req.body?.skill_md === 'string' ? req.body.skill_md : null }) }))
  r.get('/ontology/skills/:name', auth, h(async (req) => (await F()).skillTextOf(req.user, req.params.name, { jwt: req.session?.access_token || '' })))
  r.get('/ontology/cases/:id/files', auth, h(async (req) => (await import('../lib/ontology/stepdoc.js')).stepFiles(req.params.id)))
}
