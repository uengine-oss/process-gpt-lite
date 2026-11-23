// 받기만 한 메일 거르기(2026-11-24 휴대폰 녹화): 회사 쪽 누구도 답장 · 전달 · 회신하지 않은 바깥 메일(기관 교육 안내, 행사 홍보처럼
// 첨부가 있어 규칙 거르기를 지나온 것)은 회사의 일 흐름이 아니다. 「직접 답장한 적이 있어야」 — 스레드 안에 회사 사람이 쓴 메일이
// 있거나, 보낸 사람이 회사가 메일을 보낸 적이 있는 상대(주소, 공용 메일이 아니면 그 회사 도메인)일 때만 일로 본다.
// 뜻을 읽지 않는다: 누가 누구에게 썼는지라는 사실만 본다. 순수 함수 — test/ontology-engagement.test.js.
const lower = (s) => String(s || '').trim().toLowerCase()
export const addrOf = (s) => (String(s || '').match(/<([^>]+)>/)?.[1] || String(s || '')).trim().toLowerCase()
const domainOf = (a) => addrOf(a).split('@')[1] || ''

// mails: [{id, thread, from, to, cc}] — every mail of the window, sent ones included (they are the replies)
// isInside(addr): a company address; publicDomains: gmail.com · naver.com … (a domain anyone can write from)
// → { threads: Map(thread → 'inside' | 'correspondent' | null), correspondents: Set(addr | '@domain') }
export function engagementOf(mails, isInside, { publicDomains = [] } = {}) {
  const pub = new Set(publicDomains.map(lower))
  const correspondents = new Set()
  for (const m of mails) {
    if (!isInside(addrOf(m.from))) continue
    for (const x of [...(m.to || []), ...(m.cc || [])]) {
      const a = addrOf(x)
      if (!a || isInside(a)) continue
      correspondents.add(a)
      const d = domainOf(a)
      if (d && !pub.has(d)) correspondents.add(`@${d}`)
    }
  }
  const known = (a) => correspondents.has(a) || correspondents.has(`@${domainOf(a)}`)
  const threads = new Map()
  for (const m of mails) {
    const t = String(m.thread ?? m.id)
    if (threads.get(t) === 'inside') continue
    const a = addrOf(m.from)
    const why = isInside(a) ? 'inside' : known(a) ? 'correspondent' : null
    if (why === 'inside' || !threads.has(t) || (why && !threads.get(t))) threads.set(t, why)
  }
  return { threads, correspondents }
}

// a case is the company's work when any of its threads is engaged; a thread the archive does not know (no row) is kept
export function engagedCase(threadIds, threads) {
  return threadIds.some((t) => !threads.has(String(t)) || !!threads.get(String(t)))
}
