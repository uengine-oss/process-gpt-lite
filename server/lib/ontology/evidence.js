// 근거(design-v0.3 §23): 지도의 일 하나가 어디서 왔는지 — 그 일로 읽힌 메일 · 대화 메시지 · 채팅 인계 하나하나.
// 언제 · 어디서(메일 · 대화방 · 채팅 인계) · 누가 누구에게 · 부탁/결과 · 모델이 읽은 원래 말 · 건과 덩어리(AI 가 이은 줄기와 그 근거).
// 메일 제목과 원문(메일 보관함)은 그 메일함 주인에게만 보인다. 다른 사람에게는 날짜 · 출처 · 역할만.
import { config } from '../../config.js'
import { q } from '../supa.js'

const T = () => config.tenantId
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
// the original keeps its lines (a chat message's list, a mail's paragraphs), without the blank runs
const para = (s, n) => { const t = String(s || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim(); return t.length > n ? `${t.slice(0, n)}…` : t }
const nameOf = (s) => String(s || '').match(/^\s*"?([^"<]+?)"?\s*</)?.[1]?.trim() || ''
const domainOf = (a) => String(a || '').toLowerCase().match(/@([^>\s]+)>?\s*$/)?.[1] || ''

// who a row names, as the screen says it: an outside person by their company's domain, a colleague by their name (the owner's
// archive knows it) or their role, a chat speaker by their chat name
function who(addr, role, names) {
  const a = String(addr || '')
  if (a.startsWith('chat:')) return { name: a.slice(5), role: role || '' }
  if (role === '고객') return { name: `고객(${domainOf(a) || '바깥'})`, role: '고객' }
  return { name: names.get(a.toLowerCase()) || '', role: role || '' }
}

export async function taskEvidence(me, key, { limit = 40, before = null } = {}) {
  const raws = (await q(`select raw from pro_onto_labels where tenant_id=$1 and task=$2`, [T(), key])).map((r) => r.raw)
  const labels = [...new Set([key, ...raws])]
  const mh = await q(`select h.mail_id, h.case_id, h.occurred_at, h.from_addr, h.to_addrs, h.from_role, h.to_role, h.activity_label, h.act, h.attrs, h.artifacts,
                             h.owner_id::text = $3 as mine, l.stream, l.why, a.subject, a.provider, a.from_addr as from_raw, left(coalesce(nullif(a.new_part,''), a.body, ''), 600) as text
                        from pro_mail_history h
                        left join pro_case_links l on l.tenant_id=h.tenant_id and l.case_id=h.case_id
                        left join pro_mail_archive a on a.tenant_id=h.tenant_id and a.owner_id=h.owner_id and a.mail_id=h.mail_id and h.owner_id::text = $3
                       where h.tenant_id=$1 and h.activity_label = any($2) ${before ? 'and h.occurred_at < $5' : ''}
                       order by h.occurred_at desc limit $4`, [T(), labels, String(me.id), limit, ...(before ? [before] : [])])
  const ho = await q(`select id::text as id, case_id, occurred_at, from_user_name, to_user_name, from_role, to_role, coalesce(nullif(activity_label,''), next_activity_label, instruction) as raw, instruction, source
                        from handover_events where tenant_id=$1 and (activity_label = any($2) or next_activity_label = any($2) or instruction = any($2)) ${before ? 'and occurred_at < $4' : ''}
                       order by occurred_at desc limit $3`, [T(), labels, limit, ...(before ? [before] : [])]).catch(() => [])
  // the owner's colleagues by name: the sender names their archive keeps
  const names = new Map()
  for (const r of mh) { if (r.mine && r.from_raw) { const n = nameOf(r.from_raw); const m = String(r.from_raw).match(/<([^>]+)>/)?.[1]; if (n && m) names.set(m.toLowerCase(), n) } }
  const items = [
    ...mh.map((r) => {
      const chat = r.attrs?.source === 'chat'
      const to = (r.to_addrs || [])[0]
      return {
        at: r.occurred_at, source: chat ? 'chat' : 'mail', id: r.mail_id, act: r.act, raw: r.activity_label,
        // a chat message's archived sender is the speaker's chat name (chatlog.js) — the owner sees it
        from: chat && r.mine && r.from_raw && !String(r.from_raw).includes('<') ? { name: r.from_raw, role: r.from_role || '' } : who(r.from_addr, r.from_role, names),
        to: to ? who(to, r.to_role, names) : null,
        case: r.case_id, stream: r.stream || null, why: r.stream ? r.why || null : null,
        files: (r.artifacts || []).map((f) => f?.name).filter(Boolean).slice(0, 3),
        // what it was about and the original: the owner's own
        subject: r.mine ? clip(chat ? r.attrs?.subject || r.subject : r.subject, 120) : null,
        text: r.mine ? para(r.text, 500) || null : null,
        export: chat ? r.attrs?.export || null : null,
        // the mail itself in Gmail (the owner's own mailbox)
        link: r.mine && !chat && r.provider === 'gmail' && /^[0-9a-f]{10,}$/i.test(String(r.mail_id)) ? `https://mail.google.com/mail/#all/${r.mail_id}` : null,
      }
    }),
    ...ho.map((r) => ({ at: r.occurred_at, source: 'handover', id: r.id, act: null, raw: r.raw, from: { name: r.from_user_name || '', role: r.from_role || '' },
      to: r.to_user_name ? { name: r.to_user_name, role: r.to_role || '' } : null, case: r.case_id, stream: null, why: null, files: [],
      subject: clip(r.instruction, 120) || null, text: null })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit)
  const counts = await q(`select coalesce(attrs->>'source','mail') as s, count(*)::int n from pro_mail_history where tenant_id=$1 and activity_label = any($2) group by 1`, [T(), labels])
  const c = Object.fromEntries(counts.map((r) => [r.s, r.n]))
  const hoN = (await q(`select count(*)::int n from handover_events where tenant_id=$1 and (activity_label = any($2) or next_activity_label = any($2) or instruction = any($2))`, [T(), labels]).catch(() => [{ n: 0 }]))[0]?.n || 0
  return { task: key, labels: labels.length, counts: { mail: c.mail || 0, chat: c.chat || 0, handover: hoN }, items }
}
