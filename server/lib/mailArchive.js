// 메일 보관함(design-v0.3 §16, sql/035): 읽은 메일을 그 메일함 주인 몫으로 남긴다 — 지난 메일 읽기(history)와 들어온 메일(intake).
// 다시 셈하거나 나중에 다른 일에 쓸 때 메일 서버를 다시 부르지 않는다. 회사 지도와 메일 이력에는 원문을 남기지 않고, 여기는 주인만
// 연다(서버가 주인의 요청으로만 읽는다). 첨부는 내려받은 것(회사가 보낸 양식)만 파일이 있고, 나머지는 attachment_id 로 다시 받는다.
import { config } from '../config.js'
import { q } from './supa.js'

const T = () => config.tenantId
const addr = (s) => (String(s || '').match(/<([^>]+)>/)?.[1] || String(s || '')).trim().toLowerCase()
const cap = (s, n) => (s == null ? null : String(s).slice(0, n))

// mails: [{id, thread, date, from, to, cc, subject, body, text, labels, attachments}] (text = the newly written part)
export async function archiveMails(userId, provider, mails, source = 'history') {
  const rows = mails.filter((m) => m?.id && !m.fixture)
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200)
    await q(`insert into pro_mail_archive (tenant_id, owner_id, provider, mail_id, thread_id, occurred_at, from_addr, to_addrs, cc_addrs, subject, body, new_part, labels, attachments, source)
             select $1, $2, $3, x->>'id', x->>'thread', (x->>'date')::timestamptz, x->>'from', array(select jsonb_array_elements_text(x->'to')), array(select jsonb_array_elements_text(x->'cc')),
                    x->>'subject', x->>'body', x->>'text', array(select jsonb_array_elements_text(x->'labels')), coalesce(x->'attachments', '[]'::jsonb), $5
               from jsonb_array_elements($4::jsonb) x
             on conflict (tenant_id, owner_id, mail_id) do update set body = coalesce(excluded.body, pro_mail_archive.body), new_part = coalesce(excluded.new_part, pro_mail_archive.new_part),
                    attachments = case when jsonb_array_length(excluded.attachments) > 0 then excluded.attachments else pro_mail_archive.attachments end, labels = excluded.labels, read_at = now()`,
      [T(), userId, provider, JSON.stringify(part.map((m) => ({
        id: String(m.id), thread: m.thread || m.threadId || null, date: m.date ? new Date(m.date).toISOString() : null, from: cap(m.from, 300),
        to: (Array.isArray(m.to) ? m.to : String(m.to || '').split(',')).map(addr).filter(Boolean), cc: (Array.isArray(m.cc) ? m.cc : String(m.cc || '').split(',')).map(addr).filter(Boolean),
        subject: cap(m.subject, 500), body: cap(m.body ?? m.text, 100_000), text: cap(m.text, 20_000), labels: m.labels || [],
        attachments: (m.attachments || []).map((f) => ({ name: f.name, type: f.type || String(f.name || '').split('.').pop(), size: f.size || 0,
          ...(f.attachmentId ? { attachment_id: f.attachmentId } : {}), ...(f.fields?.length ? { fields: f.fields } : {}), ...(f.file ? { file: f.file } : {}) })),
      }))), source])
  }
  return rows.length
}

// the archived mails of these ids (a re-read takes them from here instead of the mail server)
export async function archivedOf(userId, ids) {
  if (!ids.length) return new Map()
  const rows = await q(`select * from pro_mail_archive where tenant_id=$1 and owner_id=$2 and mail_id = any($3)`, [T(), userId, ids])
  return new Map(rows.map((r) => [r.mail_id, r]))
}
// an archived row in the shape the readers use
export const mailOf = (r) => ({ id: r.mail_id, thread: r.thread_id, date: r.occurred_at?.toISOString?.() || r.occurred_at, from: r.from_addr, to: r.to_addrs, cc: r.cc_addrs,
  subject: r.subject || '', body: r.body || '', text: r.new_part || '', labels: r.labels || [], headers: {},
  attachments: (r.attachments || []).map((f) => ({ name: f.name, type: f.type, size: f.size, ...(f.attachment_id ? { attachmentId: f.attachment_id } : {}), ...(f.fields ? { fields: f.fields } : {}), ...(f.file ? { file: f.file } : {}) })) })

export async function listArchive(userId, { search = '', limit = 50, before = null } = {}) {
  const s = String(search || '').trim()
  return q(`select mail_id, thread_id, occurred_at, from_addr, to_addrs, subject, left(coalesce(new_part, body, ''), 300) as preview, attachments, labels, source
              from pro_mail_archive where tenant_id=$1 and owner_id=$2 ${s ? `and (subject ilike $4 or body ilike $4 or from_addr ilike $4)` : ''} ${before ? `and occurred_at < $${s ? 5 : 4}` : ''}
             order by occurred_at desc nulls last limit $3`, [T(), userId, Math.min(200, Math.max(1, Number(limit) || 50)), ...(s ? [`%${s}%`] : []), ...(before ? [before] : [])])
}
export async function readArchived(userId, mailId) {
  const [r] = await q(`select * from pro_mail_archive where tenant_id=$1 and owner_id=$2 and mail_id=$3`, [T(), userId, String(mailId)])
  return r || null
}
export async function clearArchive(userId) {
  const r = await q(`delete from pro_mail_archive where tenant_id=$1 and owner_id=$2 returning 1`, [T(), userId])
  return { deleted: r.length }
}
