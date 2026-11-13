// Gmail 지난 메일 읽기(design-v0.3 §15, lib/ontology/history.js gmailMails): Gmail API 와 같은 모양으로 답하는 모의 서버에 대고
// — 받은 메일 · 보낸 메일 모두, 본문 전체에서 지금 쓴 부분, 회사가 보낸 첨부만 내려받아 칸 이름을 읽고 양식 파일로 남기는지,
// 고객이 보낸 첨부는 내려받지 않는지. 실제 메일함 · DB 없이.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const XLSX = fs.readFileSync(new URL('../scripts/fixtures/ax-demo-templates/견적서_양식.xlsx', import.meta.url))
const H = (o) => Object.entries(o).map(([name, value]) => ({ name, value }))
const MAILS = {
  a1: { id: 'a1', threadId: 't1', internalDate: String(Date.parse('2026-11-02T10:12:00+09:00')), labelIds: ['INBOX'],
    payload: { mimeType: 'multipart/mixed', headers: H({ From: '정하늘 <haneul@dalbitcoffee.example>', To: 'pro-ax-jinyoung@uengine.org', Subject: '2호점 견적 다시 부탁드려요' }), parts: [
      { mimeType: 'text/html', body: { data: b64u('<p>좌석을 32석에서 <b>40석</b>으로 늘려 견적 다시 부탁드립니다.</p>') } },
      { mimeType: 'application/pdf', filename: '2호점_도면.pdf', body: { attachmentId: 'pdf1', size: 380000 } }] } },
  a2: { id: 'a2', threadId: 't1', internalDate: String(Date.parse('2026-11-03T15:40:00+09:00')), labelIds: ['SENT'],
    payload: { mimeType: 'multipart/mixed', headers: H({ From: '이도윤 <pro-ax-doyun@uengine.org>', To: 'haneul@dalbitcoffee.example', Subject: 'RE: 2호점 견적 다시 부탁드려요' }), parts: [
      { mimeType: 'text/plain', body: { data: b64u('견적서 첨부합니다. 합계 12,400,000원입니다.\n\n2026년 11월 2일 (월) 오전 10:12, 정하늘 <haneul@dalbitcoffee.example>님이 작성:\n> 좌석을 32석에서 40석으로') } },
      { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: '견적서_달빛커피_2호점.xlsx', body: { attachmentId: 'xl1', size: XLSX.length } }] } },
}
const ATT = { xl1: XLSX, pdf1: Buffer.from('%PDF-1.4') }

test('Gmail: 받은 · 보낸 메일, 지금 쓴 부분, 회사가 보낸 첨부만 열어 양식으로', async (t) => {
  const hits = []
  const srv = http.createServer((req, res) => {
    hits.push(req.url)
    assert.equal(req.headers.authorization, 'Bearer test-token')
    const u = new URL(req.url, 'http://x')
    const send = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)) }
    let m
    if (u.pathname === '/messages') return send({ messages: Object.keys(MAILS).map((id) => ({ id, threadId: MAILS[id].threadId })) })
    if ((m = u.pathname.match(/^\/messages\/(\w+)\/attachments\/(\w+)$/))) return send({ data: b64u(ATT[m[2]]), size: ATT[m[2]].length })
    if ((m = u.pathname.match(/^\/messages\/(\w+)$/))) return send(MAILS[m[1]])
    res.statusCode = 404; res.end('{}')
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  t.after(() => srv.close())
  process.env.PRO_GMAIL_API = `http://127.0.0.1:${srv.address().port}`
  const { gmailMails } = await import('../lib/ontology/history.js')
  const formsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'forms-'))
  const inside = new Map([['pro-ax-doyun@uengine.org', { role: '영업', label: '이도윤(영업)' }], ['pro-ax-jinyoung@uengine.org', { role: '제안팀장', label: '장진영(제안팀장)' }]])
  const mails = await gmailMails('test-token', 90, { inside, formsDir })
  assert.equal(mails.length, 2)
  const [got, sent] = mails
  assert.equal(got.text, '좌석을 32석에서 40석으로 늘려 견적 다시 부탁드립니다.')
  // a customer's attachment is not downloaded: its name, kind and id (to fetch it again later) only
  assert.deepEqual(got.attachments, [{ name: '2호점_도면.pdf', type: 'pdf', size: 380000, attachmentId: 'pdf1' }])
  assert.equal(sent.text, '견적서 첨부합니다. 합계 12,400,000원입니다.')
  assert.deepEqual(sent.labels, ['SENT'])
  const q = sent.attachments[0]
  assert.equal(q.file, 'forms/견적서.xlsx')
  for (const l of ['고객명', '견적일', '프로젝트']) assert.ok(q.fields.includes(l), l)
  assert.ok(fs.existsSync(path.join(formsDir, '견적서.xlsx')))
  assert.ok(!hits.some((h) => h.includes('/attachments/pdf1')), '고객이 보낸 첨부를 내려받았다')
  assert.match(sent.body, /님이 작성:/) // the whole body is kept for the mail archive; the model gets the new part
  assert.equal(got.attachments.length, 1)

  // read again: a mail already in the owner's mail archive is not fetched from Gmail again
  hits.length = 0
  const again = await gmailMails('test-token', 90, { inside, archived: async (ids) => new Map(ids.filter((id) => id === 'a2').map((id) => [id, { ...sent }])) })
  assert.equal(again.length, 2)
  assert.ok(!hits.includes('/messages/a2?format=full') && hits.includes('/messages/a1?format=full'), hits.join(' '))
  assert.equal(again[1].archived, true)
})
