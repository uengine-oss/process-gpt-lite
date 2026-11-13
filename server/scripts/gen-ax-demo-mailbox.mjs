// The process-ontology demo's mailbox (tenant ax-demo, scripts/ax-demo.mjs): 90 days of mail of 장진영, the
// proposal team lead of a small interior design & build firm (설계 · 시공), generated from a fixed process
// model with a seeded PRNG (no LLM), so every run writes the same file byte for byte.
//   node scripts/gen-ax-demo-mailbox.mjs              writes scripts/fixtures/ax-demo-mailbox.json (and the quote
//                                                     template ax-demo-templates/견적서_양식.xlsx when it is missing)
//   node scripts/gen-ax-demo-mailbox.mjs --templates  writes the quote template again too
//   node scripts/gen-ax-demo-mailbox.mjs --stdout     prints the JSON instead of writing it
// The ground truth the mail and chat were made from is in the file too (truth.cases, truth.chat_cases), and the
// chat handovers scripts/ax-demo.mjs --seed writes to handover_events (chat_handovers).
//
// Ground truth (bundles):
//   A 「설계 제안 · 견적」  요청 메일 접수 → 현장 실측 → 평면도 작성 → 제안서 작성 → 견적서 작성 → [재무 검토, when the
//                         quote is 10,000,000원 or more] → 고객 회신; old bypass 요청 → 평면도 (no 현장 실측, only before
//                         09-05); re-quote 요청 → 견적서 → [재무] → 회신; revision loop 회신 → 제안서 → 견적서 → 회신;
//                         one 견적서 → 법무 검토 → 회신
//   B 「계약 · 시공 준비」  계약 확정 → {자재 발주, 시공 일정 조율} in either order → 착공 안내
//   C 「하자 · AS」        하자 접수 → 현장 방문 → 처리 보고
// Customers are fictional and use reserved example domains only (*.example, example.com/net/org).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const FIX = path.join(here, 'fixtures')
const OUT = path.join(FIX, 'ax-demo-mailbox.json')
const TEMPLATE_DIR = path.join(FIX, 'ax-demo-templates')
const QUOTE_TEMPLATE = '견적서_양식.xlsx'
const QUOTE_FILE = `ax-demo-templates/${QUOTE_TEMPLATE}`
// the report forms of the work at set times (writeFormTemplate)
const FORMS = [
  ['주간공정보고_양식.xlsx', '주 간 공 정 보 고', [['현장명', '보고일'], ['공정률(%)', '작성자'], ['이번 주 한 일'], ['다음 주 할 일'], ['특이 사항'], ['현장 사진']]],
  ['월결산_양식.xlsx', '월 결 산 보 고', [['기간', '작성자'], ['매출', '매입'], ['미수금', '미지급금'], ['현장별 미수금'], ['비고']]],
]
const has = (k) => process.argv.includes(k)

// ---------------------------------------------------------------- randomness (seeded, one stream)
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rnd = mulberry32(20261112)
const between = (a, b) => a + rnd() * (b - a)
const int = (a, b) => Math.floor(between(a, b + 1))
const pick = (arr) => arr[Math.floor(rnd() * arr.length)]
const chance = (p) => rnd() < p
const shuffle = (arr) => { const a = [...arr]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]] } return a }

// ---------------------------------------------------------------- time (KST wall clock held as UTC ms)
const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR
const day = (s) => Date.parse(`${s}T00:00:00Z`)
const FROM = day('2026-08-12'), TO = day('2026-11-10')
const CUTOFF = TO + 20 * HOUR // nothing after 2026-11-10 20:00
// 광복절 대체 · 추석 · 개천절 대체 · 한글날
const HOLIDAYS = new Set(['2026-08-17', '2026-09-24', '2026-09-25', '2026-09-26', '2026-10-05', '2026-10-09'])
const ymd = (t) => new Date(t).toISOString().slice(0, 10)
const midnight = (t) => t - (((t % DAY) + DAY) % DAY)
const isBiz = (t) => { const w = new Date(t).getUTCDay(); return w > 0 && w < 6 && !HOLIDAYS.has(ymd(t)) }
const nextBiz = (d) => { let x = midnight(d); while (!isBiz(x)) x += DAY; return x }
const iso = (t) => `${new Date(t).toISOString().slice(0, 16)}:00+09:00`
const WD = '일월화수목금토'
const md = (t) => { const d = new Date(t); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})` }
const hm = (t) => { const d = new Date(t); const h = d.getUTCHours(), m = d.getUTCMinutes(); return `${h < 12 ? '오전' : '오후'} ${h % 12 || 12}시${m ? ` ${m}분` : ''}` }
const roundMin = (t) => Math.round(t / MIN) * MIN
const WORK_START = 9 * HOUR, WORK_END = 18 * HOUR
function intoWork(t) {
  const d = midnight(t)
  if (!isBiz(d)) return nextBiz(d) + WORK_START
  if (t - d < WORK_START) return d + WORK_START
  if (t - d >= WORK_END) return nextBiz(d + DAY) + WORK_START
  return t
}
// a moment `hours` working hours (09–18, business days) after t
function addWork(t, hours) {
  let ms = intoWork(t), left = hours * HOUR
  while (left > 0) {
    const end = midnight(ms) + WORK_END
    if (left <= end - ms) { ms += left; left = 0 } else { left -= end - ms; ms = nextBiz(midnight(ms) + DAY) + WORK_START }
  }
  return ms
}
const work = (t, a, b) => roundMin(addWork(t, between(a, b)) + int(0, 4) * MIN)
// a customer writes on any day, mostly in office hours, sometimes in the evening
function custTime(d) {
  const at = chance(0.75) ? between(9, 18) : between(19, 23.5)
  return roundMin(midnight(d) + at * HOUR)
}
const custAfter = (t, d1, d2) => { let x = custTime(midnight(t) + int(d1, d2) * DAY); if (x <= t + HOUR) x = t + HOUR + int(5, 50) * MIN; return roundMin(x) }

// ---------------------------------------------------------------- Korean particles
const jong = (w) => { const c = String(w).trim().slice(-1).charCodeAt(0); if (c >= 0xAC00 && c <= 0xD7A3) return (c - 0xAC00) % 28; return /[013678]$/.test(String(w)) ? 1 : 0 }
const eul = (w) => `${w}${jong(w) ? '을' : '를'}`
const iga = (w) => `${w}${jong(w) ? '이' : '가'}`
const eunneun = (w) => `${w}${jong(w) ? '은' : '는'}`
const ro = (w) => { const j = jong(w); return `${w}${j === 0 || j === 8 ? '로' : '으로'}` }
const qro = (w) => `'${w}'${ro(w).slice(w.length)}`
const won = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const amtText = (n) => `${won(n)}원(부가세 별도)`
const manwon = (n) => `${won(n / 10000)}만 원`

// ---------------------------------------------------------------- people
const OWNER = 'pro-ax-jinyoung@uengine.org'
const JIN = OWNER, DOYUN = 'pro-ax-doyun@uengine.org', MINJI = 'pro-ax-minji@uengine.org', SEOYEON = 'pro-ax-seoyeon@uengine.org'
const CAST = {
  [JIN]: { name: '장진영', role: '제안팀장' },
  [DOYUN]: { name: '이도윤', role: '영업' },
  [MINJI]: { name: '김민지', role: '디자이너' },
  [SEOYEON]: { name: '박서연', role: '재무 담당' },
}
const AGENTS = {
  floorplan: { id: 'ax-agent-floorplan', name: '평면도 에이전트' },
  proposal: { id: 'ax-agent-proposal', name: '제안서 에이전트' },
}

// fictional customers: [name, category, contact, email]
const CUSTOMERS = [
  ['달빛커피', 'cafe', '정하늘', 'haneul@dalbitcoffee.example'],
  ['소나무치과', 'dental', '윤재석', 'office@sonamu-dental.example'],
  ['하늘정원 카페', 'cafe', '오세린', 'serin.oh@example.com'],
  ['바른정형외과', 'clinic', '강민호', 'admin@bareun-ortho.example'],
  ['마루서점', 'books', '서지우', 'jiwoo@maru-books.example'],
  ['한결한의원', 'clinic', '백승현', 'hangyeol.clinic@example.net'],
  ['푸른숲 어린이집', 'kids', '임수아', 'pureunsup@example.org'],
  ['새봄 필라테스', 'fitness', '문예린', 'yerin@saebom-pilates.example'],
  ['다온 헤어', 'beauty', '차유진', 'daonhair@example.com'],
  ['별빛 스터디카페', 'edu', '홍준서', 'junseo.hong@byeolbit.example'],
  ['고운피부과', 'clinic', '신다인', 'manager@goun-derm.example'],
  ['청솔약국', 'retail', '조은우', 'cheongsol.pharm@example.net'],
  ['해담 레스토랑', 'food', '류태오', 'taeo@haedam-dining.example'],
  ['모아 공유오피스', 'office', '남궁현', 'hyun.ng@moa-office.example'],
  ['라온 키즈카페', 'kids', '장보람', 'boram@raon-kids.example'],
  ['미소치과', 'dental', '권도현', 'dohyun.k@miso-dental.example'],
  ['봄날 꽃집', 'retail', '하지민', 'bomnal.flower@example.com'],
  ['단풍 한식당', 'food', '송재원', 'jaewon@danpung.example'],
  ['소담 갤러리', 'retail', '염서아', 'seoa@sodam-gallery.example'],
  ['나무향 가구 쇼룸', 'retail', '유건우', 'showroom@namuhyang.example'],
  ['바다마을 횟집', 'food', '표성민', 'badamaeul@example.net'],
  ['하람 소아과', 'clinic', '진나연', 'nayeon.jin@haram-peds.example'],
  ['가온 안경원', 'retail', '엄태윤', 'gaon.optical@example.org'],
  ['숲속 요가', 'fitness', '노하은', 'haeun@supsok-yoga.example'],
  ['도담 수학학원', 'edu', '원지훈', 'jihoon@dodam-math.example'],
  ['산들 베이커리', 'food', '맹소율', 'soyul.m@example.net'],
  ['솔빛 서점', 'books', '기현우', 'hyunwoo@solbit-books.example'],
  ['늘봄 내과', 'clinic', '석예준', 'office@neulbom-im.example'],
  ['초록 샐러드', 'food', '피수빈', 'subin@chorok-salad.example'],
  ['누리 영어학원', 'edu', '탁서진', 'seojin@nuri-english.example'],
  ['꿈꾸는 공방', 'retail', '변하린', 'harin.byun@example.com'],
  ['단비 네일', 'beauty', '곽민재', 'danbi.nail@example.net'],
  ['해오름 치킨', 'food', '함지아', 'jia@haeoreum.example'],
  ['온유 정신건강의학과', 'clinic', '주연서', 'yeonseo.ju@onyu-clinic.example'],
  ['이랑 와인바', 'food', '국태민', 'taemin@irang-wine.example'],
  ['마중 게스트하우스', 'retail', '어진혁', 'majung.guest@example.org'],
  ['고요 독서실', 'edu', '인소희', 'sohee@goyo-reading.example'],
  ['새싹 동물병원', 'clinic', '감도원', 'dowon@saessak-vet.example'],
  ['포근 산후조리원', 'kids', '봉시우', 'siwoo.bong@pogeun-care.example'],
  ['한올 한복', 'retail', '설민준', 'hanol.hanbok@example.com'],
  ['빛담 사진관', 'retail', '채은비', 'eunbi@bitdam-photo.example'],
  ['다래 정육식당', 'food', '길하람', 'haram.gil@darae-meat.example'],
  ['바로핏 짐', 'fitness', '위재민', 'jaemin@barofit.example'],
  ['연두 어린이치과', 'dental', '반서윤', 'seoyun.ban@yeondu-dental.example'],
  ['온기 브런치', 'food', '육다현', 'dahyun@ongi-brunch.example'],
  ['다정 세무회계', 'office', '성지호', 'jiho.sung@dajeong-tax.example'],
  ['솜씨 떡집', 'food', '왕미숙', 'somssi.tteok@example.net'],
  ['고래 문구', 'retail', '남도영', 'doyoung.nam@gorae-stationery.example'],
  ['정담 한정식', 'food', '소현철', 'hyeoncheol@jeongdam.example'],
  ['무지개 피아노 학원', 'edu', '우가은', 'gaeun.woo@example.org'],
  ['느린 책방 카페', 'books', '엄지수', 'jisu@neurin-cafe.example'],
  ['새벽 베이글', 'food', '마준혁', 'junhyuk@saebyeok-bagel.example'],
].map(([name, cat, contact, email]) => ({ name, cat, contact, email }))

const LOCATIONS = ['연남동', '성수동', '망원동', '합정동', '판교', '분당 정자동', '광교', '송도', '일산 백석동', '수원 인계동', '해운대 우동',
  '대전 둔산동', '부산 서면', '청주 복대동', '인천 구월동', '용인 수지', '하남 미사', '김포 장기동', '안양 평촌', '강릉 교동']
const BRANCHES = {
  cafe: ['2호점', '신규 매장', '리뉴얼'], dental: ['리모델링', '신규 개원', '2층 확장'], clinic: ['신규 개원', '리모델링', '확장 이전'],
  books: ['2호점', '리뉴얼', '신규 매장'], edu: ['신규 지점', '확장 이전', '리모델링'], fitness: ['2호점', '신규 스튜디오', '리뉴얼'],
  beauty: ['2호점', '리뉴얼', '신규 매장'], food: ['2호점', '신규 매장', '리뉴얼'], retail: ['신규 매장', '리뉴얼', '이전 오픈'],
  office: ['3층 확장', '신규 지점', '리모델링'], kids: ['신규 개원', '리모델링'],
}
const BRANCH_PHRASE = { '2호점': '2호점 오픈', '신규 매장': '새 매장 오픈', 리뉴얼: '매장 리뉴얼', 리모델링: '리모델링', '신규 개원': '신규 개원',
  '확장 이전': '확장 이전', '2층 확장': '2층 확장 공사', '신규 스튜디오': '새 스튜디오 오픈', '신규 지점': '새 지점 오픈', '이전 오픈': '이전 오픈', '3층 확장': '3층 확장 공사' }
const AREA = { cafe: [12, 30], dental: [30, 55], clinic: [28, 60], books: [15, 40], edu: [25, 50], fitness: [20, 45], beauty: [10, 25],
  food: [15, 40], retail: [8, 25], office: [35, 60], kids: [30, 60] }
const TITLE = { cafe: '대표님', food: '대표님', beauty: '대표님', retail: '대표님', fitness: '대표님', books: '대표님', office: '대표님',
  dental: '원장님', clinic: '원장님', edu: '원장님', kids: '원장님' }
const NEEDS = {
  cafe: ['창가 쪽에 바 테이블을 두고 좌석은 {n}석 정도 원해요.', '로스팅 기계 놓을 자리가 따로 있어야 합니다.', '테이크아웃 손님 동선이 매장 손님과 겹치지 않았으면 해요.'],
  dental: ['진료 체어 {n}대와 상담실 하나가 필요합니다.', '대기실이 지금보다 넓어 보였으면 합니다.', '소독실 동선을 진료실과 따로 빼고 싶습니다.'],
  clinic: ['진료실 {n}개와 처치실 하나가 필요합니다.', '접수대와 대기 공간 배치가 가장 고민입니다.', '물리치료실을 넓게 쓰고 싶습니다.'],
  books: ['서가는 벽면 위주로 두고 가운데에 작은 북토크 공간을 만들고 싶어요.', '창가에 앉아서 읽을 수 있는 자리가 {n}석 정도 있었으면 해요.'],
  edu: ['강의실 {n}개와 상담실 하나가 필요합니다.', '방음이 잘 되는 게 제일 중요합니다.', '1인 좌석을 {n}석 정도 생각하고 있어요.'],
  fitness: ['기구 {n}대가 들어갈 공간과 탈의실이 필요해요.', '층간 소음 때문에 바닥 방진이 중요합니다.'],
  beauty: ['시술 의자 {n}개와 샴푸대 두 개가 들어가야 합니다.', '대기 공간을 아늑하게 꾸미고 싶어요.'],
  food: ['주방을 넉넉하게 빼고 홀은 {n}석 정도 원합니다.', '배기 덕트 위치가 제일 고민입니다.', '단체 손님용 룸이 하나 있으면 좋겠어요.'],
  retail: ['진열대는 벽면 위주로 두고 가운데는 비워 두고 싶어요.', '작업 공간과 손님 공간을 나누고 싶습니다.', '수납을 넉넉하게 해 주세요.'],
  office: ['회의실 {n}개와 폰부스 몇 개가 필요합니다.', '개방형 좌석과 집중 업무 공간을 나누고 싶습니다.'],
  kids: ['아이들 동선이 안전했으면 좋겠고 모서리는 전부 둥글게 해 주세요.', '보호자 대기 공간과 놀이 공간을 유리로 나누고 싶어요.'],
}
const NEED_N = { cafe: [16, 40], dental: [3, 7], clinic: [2, 5], books: [6, 14], edu: [3, 8], fitness: [6, 14], beauty: [3, 6], food: [20, 48], retail: [2, 4], office: [2, 5], kids: [2, 4] }
const STYLES = ['따뜻한 우드톤', '화이트 앤 오크 미니멀', '그린 포인트가 들어간 내추럴', '차분한 그레이에 브라스 포인트', '밝은 파스텔 톤', '노출 콘크리트와 원목', '곡선이 많은 부드러운']
const CONCEPTS = ['머무르고 싶은 우드 라운지', '빛이 드는 화이트 오크', '숲을 들인 내추럴', '차분한 갤러리형 공간', '밝고 둥근 동선', '원목과 콘크리트의 대비']
const CEILINGS = ['2.6', '2.7', '2.8', '3.0', '3.2', '3.4']

// ---------------------------------------------------------------- mail and chat stores
const mails = [] // { key, at, from, to, cc, subject, text, quoted, attachments, kind, thread, headers }
let mailSeq = 0
function mail(m) {
  if (m.at > CUTOFF) return null
  const r = { key: ++mailSeq, kind: 'work', to: [], cc: [], attachments: [], ...m }
  mails.push(r)
  return r
}
const re = (s) => (/^(RE|회신): /.test(s) ? s : `${pick(['RE', 'RE', 'RE', '회신'])}: ${s}`)
const fw = (s) => `${pick(['FW', 'FW', '전달'])}: ${s}`
const nameOf = (email) => CAST[email]?.name || CUSTOMER_BY_EMAIL.get(email)?.contact || email
const CUSTOMER_BY_EMAIL = new Map(CUSTOMERS.map((c) => [c.email, c]))
function quote(m) {
  if (!m) return undefined
  const d = new Date(m.at)
  return `--- 원본 메일 ---\n보낸 사람: ${nameOf(m.from)} <${m.from}>\n보낸 날짜: ${d.getUTCFullYear()}. ${d.getUTCMonth() + 1}. ${d.getUTCDate()}. ${hm(m.at)}\n제목: ${m.subject}\n\n${m.text}${m.quoted ? `\n\n${m.quoted}` : ''}`
}
const att = (name, type, kb1, kb2, extra = {}) => ({ name, type, size: int(kb1 * 1024, kb2 * 1024), ...extra })
const quoteFile = (name) => att(name, 'xlsx', 15, 30, { file: QUOTE_FILE })

const chatCases = [] // { key, thread, bundle, rows: [...], steps: [...] }
function chatCase(c, kind) {
  const cc = { key: chatCases.length + 1, thread: c.thread, bundle: c.bundle, kind, rows: [], steps: [] }
  chatCases.push(cc)
  return cc
}
// a chat row: from → to (a person's email, or an agent), the raw text, what it is about (truth)
function row(cc, r) { if (r.at > CUTOFF) return false; cc.rows.push(r); return true }

// ---------------------------------------------------------------- cases
const cases = []
function newCase(fields) {
  const c = { key: cases.length + 1, steps: [], extra: new Set(), open: false, amounts: [], ...fields }
  cases.push(c)
  return c
}
// a step of the case's truth; false (and the case stays open) when it would happen after the window
function step(c, task, who, at, ev = {}) {
  if (at > CUTOFF) { c.open = true; return false }
  const s = { task, who, at, ...ev }
  c.steps.push(s)
  return s
}
const viaMail = (m) => (m ? { mailKey: m.key } : null)

function slugOf(project) { return project.replace(/\s+/g, '_') }
function projectFor(cust) {
  const branch = pick(BRANCHES[cust.cat])
  return { branch, project: `${cust.name} ${branch}`, phrase: BRANCH_PHRASE[branch] }
}
function amountFor(big) {
  if (big) return Math.round((10e6 + 30e6 * Math.pow(rnd(), 1.7)) / 1e5) * 1e5
  return Math.round(between(3.0e6, 9.95e6) / 1e5) * 1e5
}

// ---------------------------------------------------------------- texts
const title = (c) => TITLE[c.cust.cat]
const needOf = (c) => pick(NEEDS[c.cust.cat]).replace('{n}', String(int(...NEED_N[c.cust.cat])))
function requestText(c, { drawing = false, legal = false } = {}) {
  const k = c.cust
  // (one sentence each: a request stays within 2–6 sentences)
  const s = [pick([`안녕하세요, ${k.name} ${k.contact}입니다.`, `안녕하세요, ${k.name}의 ${k.contact}${jong(k.contact) ? '이라고' : '라고'} 합니다.`,
    `수고 많으십니다, ${k.name} ${k.contact}입니다.`, `안녕하세요, 지인 소개로 연락드리는 ${k.name} ${k.contact}입니다.`])]
  s.push(pick([`${c.loc}에서 ${c.area}평 규모로 ${eul(c.phrase)} 준비하고 있습니다.`, `이번에 ${c.loc}에 ${c.area}평 정도 되는 공간으로 ${eul(c.phrase)} 하게 되었습니다.`,
    `${c.loc} ${c.area}평 공간의 ${c.phrase} 건으로 연락드려요.`]))
  s.push(needOf(c))
  if (drawing) s.push(pick(['건물주에게 받은 기존 도면을 첨부합니다. 실측 없이 이 도면으로 바로 진행해 주셔도 괜찮습니다.',
    '예전 공사 때 받은 도면이 있어서 첨부드려요. 치수는 도면과 거의 같으니 이걸로 진행해 주세요.']))
  else if (legal) s.push('계약하게 되면 하자보수 기간과 지체상금 조항이 어떻게 되는지도 함께 알려 주시면 좋겠습니다.')
  else {
    const extra = int(0, 3)
    if (extra === 1) s.push(pick([`전체적으로 ${STYLES[int(0, STYLES.length - 1)]} 느낌이면 좋겠어요.`, `${pick(STYLES)} 분위기를 생각하고 있습니다.`]))
    if (extra === 2) s.push(`예산은 ${manwon(Math.max(5e6, Math.round(c.amount / 5e6) * 5e6))} 안팎으로 보고 있습니다.`)
    if (extra === 3) s.push(pick([`${new Date(c.start).getUTCMonth() + 2}월 중 오픈이 목표입니다.`, '가능하면 이번 주나 다음 주 중에 현장을 한번 봐 주셨으면 해요.']))
  }
  s.push(pick(['설계 제안서와 견적을 받아 볼 수 있을까요?', '평면 계획과 견적 부탁드립니다.', '제안서와 견적서를 함께 받아 보고 싶습니다.',
    '대략적인 공사 범위와 견적을 알려 주시면 감사하겠습니다.']))
  const close = pick(['감사합니다.', '회신 기다리겠습니다.', '잘 부탁드립니다.', ''])
  if (close && !drawing && s.length < 6) s.push(close)
  return s.join(' ')
}
const requestSubject = (c) => pick([`[${c.cust.name}] ${c.branch} 인테리어 설계 제안·견적 요청`, `${c.project} 인테리어 견적 문의드립니다`,
  `${c.project} 인테리어 상담 요청`, `인테리어 설계/시공 견적 문의 (${c.project})`, `[문의] ${c.project} 설계 및 견적`])
const ackText = (c) => pick([
  `${title(c)} 안녕하세요, 영업 담당 이도윤입니다. 보내 주신 메일 잘 받았습니다. 디자이너와 실측 일정을 잡아서 다시 연락드리겠습니다.`,
  `문의 감사합니다, 이도윤입니다. 내용 확인했고 이번 주 안에 현장 확인 일정을 안내드릴게요.`,
  `${c.cust.contact} ${title(c)}, 메일 잘 받았습니다. 검토해서 곧 연락드리겠습니다. 이도윤 드림`])
const measureAsk = (c, visit) => pick([
  `민지 님, ${c.project} 현장 실측 부탁드려요. 주소는 ${c.loc}이고 고객님은 ${md(visit)} 오후가 편하시다고 합니다.`,
  `민지 님, 아래 문의 건 실측 일정 잡아 주실 수 있을까요? ${c.loc} ${c.area}평이고, ${md(visit)}쯤이면 좋겠다고 하셨어요. 팀장님 참조 넣었습니다.`,
  `${c.project} 건 실측 부탁드립니다. 고객 연락처는 아래 원본 메일에 있어요.`])
function measureDone(c, t) {
  const ceil = pick(CEILINGS)
  return pick([
    `${md(t)} ${c.loc} 현장 실측 다녀왔습니다. 천장고는 ${ceil}m이고 기둥이 ${int(1, 3)}개 있어서 배치할 때 참고해야 할 것 같아요. 사진과 치수 메모는 공유 폴더에 올려 두었습니다.`,
    `오늘 ${c.project} 실측 마쳤어요. 전기 분전반이 출입구 옆에 있어서 카운터 위치를 조금 옮겨야 할 것 같습니다. 평면도는 정리해서 보내드릴게요.`,
    `실측 다녀왔습니다. 전용 ${c.area}평이라고 하셨는데 실제로는 약 ${(c.area * 3.3058 * between(0.92, 0.98)).toFixed(1)}㎡로 조금 작게 나와요. 급배수는 북쪽 벽에만 있습니다.`,
    `${c.project} 현장 확인했습니다. 천장고 ${ceil}m, 창이 남향이라 채광은 좋아요. 사진은 폴더에 올렸습니다.`])
}
function planNote(c) {
  const k = c.cust.cat
  if (k === 'cafe' || k === 'food') return pick([`좌석은 ${int(16, 40)}석 기준이고 바 테이블을 창가로 뺐어요.`, '주방과 홀 사이 동선을 한 방향으로 정리했습니다.', '화장실은 기존 배관 때문에 위치를 그대로 두었어요.'])
  if (k === 'dental' || k === 'clinic') return pick([`진료실 ${int(2, 5)}개와 상담실을 복도 한쪽으로 모았습니다.`, '대기실을 창가로 옮겨서 훨씬 넓어 보여요.', '소독실 동선을 따로 분리했습니다.'])
  return pick(['수납장은 벽면을 따라 붙였습니다.', '손님 공간과 작업 공간을 가벽으로 나눴어요.', '출입구 쪽을 비워서 동선이 막히지 않게 했습니다.'])
}
const planShare = (c) => pick([
  `${c.project} 평면도 보내드려요. ${planNote(c)} 확인 부탁드립니다.`,
  `평면도 1차안 공유드립니다. ${planNote(c)} 수정할 부분 있으면 말씀 주세요.`,
  `도윤 님, 요청하신 평면도 완성했어요. ${planNote(c)}`])
const proposalText = (c) => pick([
  `팀장님, ${c.project} 제안서 초안 공유드립니다. 콘셉트는 ${qro(pick(CONCEPTS))} 잡았고 평면도는 민지 님 안을 그대로 넣었습니다. 의견 주시면 반영하겠습니다.`,
  `${c.project} 제안서 작성했습니다. 고객님이 강조하신 요구 사항을 앞쪽에 정리했어요. 내일 견적서까지 마무리하겠습니다.`,
  `제안서 초안입니다. 자재·마감 쪽은 ${pick(STYLES)} 톤으로 구성했습니다. 확인 부탁드립니다.`])
const quoteInternalText = (c, amount, { mentionRule = false, finChat = false, label = '' } = {}) => {
  const s = [pick([`${label || c.project} 견적서 작성했습니다. 합계 ${amtText(amount)}입니다.`, `${label || c.project} 견적서 공유드립니다. 합계는 ${amtText(amount)}입니다.`,
    `견적 정리했습니다. ${label || c.project} 합계 ${amtText(amount)}이에요.`])]
  if (finChat) s.push(pick(['재무 검토는 서연 님께 메신저로 요청해 두었어요.', '서연 님 검토는 메신저로 따로 부탁드렸습니다.', '']))
  else if (mentionRule) s.push(pick(['1천만 원이 안 돼서 재무 검토 없이 바로 고객님께 회신드리겠습니다.', '금액이 크지 않아서 오늘 바로 회신드리겠습니다.']))
  else s.push(pick(['오늘 중으로 고객님께 회신드릴게요.', '문제없으면 내일 오전에 보내겠습니다.', '']))
  return s.filter(Boolean).join(' ')
}
const financeAsk = (c, amount, due, label = '') => pick([
  `서연 님, ${label || c.project} 견적 검토 부탁드립니다. 합계 ${amtText(amount)}이고 자재비 비중이 ${int(38, 62)}% 정도예요. 고객님께 ${md(due)}까지 회신드리기로 했습니다.`,
  `재무 검토 요청드립니다. ${label || c.project} 견적 합계 ${amtText(amount)}입니다. 첨부한 견적서 확인 부탁드려요.`,
  `서연 님, ${c.cust.name} 견적이 ${amtText(amount)}이라 검토 부탁드려요. 단가표는 지난달 기준으로 넣었습니다.`])
function financeOk(waitDays) {
  const late = waitDays >= 1.5 ? pick(['월말 마감 때문에 늦어졌어요. ', '답이 늦어 죄송해요. ', '']) : ''
  return late + pick([
    `검토했습니다. 마진율 ${int(18, 31)}%로 괜찮아서 승인합니다.`,
    '단가 확인했고 승인합니다. 결제 조건은 계약금 30%로 넣어 주세요.',
    '자재비 일부가 지난달 단가라 조금 올려서 시트에 반영했어요. 그 기준으로 승인합니다.',
    '확인했습니다. 승인합니다. 고객님께 회신하셔도 됩니다.'])
}
const replyText = (c, amount, { extra = '' } = {}) => [pick([
  `${c.cust.contact} ${title(c)}, 안녕하세요. 이도윤입니다. 요청하신 ${c.project} 설계 제안서와 견적서를 보내드립니다.`,
  `${title(c)} 안녕하세요, 이도윤입니다. ${c.project} 제안서와 견적서 첨부드립니다.`,
  `안녕하세요, ${c.cust.contact} ${title(c)}. 기다려 주셔서 감사합니다. ${c.project} 설계 제안과 견적 보내드립니다.`]),
`합계는 ${amtText(amount)}이며 견적 유효기간은 30일입니다.`, extra,
pick(['궁금하신 점은 편하게 연락 주세요.', '검토해 보시고 의견 주시면 반영하겠습니다.', '현장 미팅이 필요하시면 일정 맞춰 찾아뵙겠습니다.'])].filter(Boolean).join(' ')

const CHANGES = [
  { ask: '바닥재를 강마루에서 포세린 타일로', short: '바닥재 변경', f: [1.05, 1.2] },
  { ask: '좌석 수를 네 석 늘려서', short: '좌석 추가', f: [1.04, 1.15], cats: ['cafe', 'food', 'edu', 'books'] },
  { ask: '조명 수량을 줄여서', short: '조명 수량 조정', f: [0.88, 0.97] },
  { ask: '벽 마감을 필름 대신 도장으로', short: '벽 마감 변경', f: [0.9, 0.98] },
  { ask: '주방 설비는 빼고', short: '주방 설비 제외', f: [0.75, 0.9], cats: ['cafe', 'food'] },
  { ask: '간판 공사까지 포함해서', short: '간판 공사 포함', f: [1.08, 1.2] },
  { ask: '화장실 공사를 추가해서', short: '화장실 공사 추가', f: [1.1, 1.25] },
]
const CUTS = [
  { ask: '가구 일부는 기존 것을 쓰는 걸로', done: '가구 일부를 기존 것 재사용으로 바꿨습니다' },
  { ask: '천장 공사는 빼고', done: '천장은 도장만 하는 것으로 바꿨습니다' },
  { ask: '바닥재를 데코타일로 바꿔서', done: '바닥재를 데코타일로 낮췄습니다' },
  { ask: '조명은 기본형으로 바꿔서', done: '조명을 기본형으로 바꿨습니다' },
]
const DEFECTS = [
  { d: '화장실 실리콘이 들떠서 물이 스며드는 것 같아요.', short: '화장실 실리콘', fix: '기존 실리콘을 걷어 내고 방수 실리콘으로 다시 시공했습니다.' },
  { d: '출입문이 끝까지 안 닫히고 자꾸 걸립니다.', short: '출입문', fix: '도어 클로저 속도를 조정하고 경첩을 교체했습니다.' },
  { d: '카운터 위 조명 하나가 계속 깜빡거려요.', short: '조명 깜빡임', fix: '안정기 불량이라 조명 기구를 새것으로 바꿨습니다.' },
  { d: '바닥 타일 한 장에 금이 갔어요.', short: '바닥 타일', fix: '금 간 타일 한 장을 같은 품번으로 교체했습니다.' },
]
const SUPPLIERS = ['가람타일', '빛나조명', '목향목재', '한빛도장']

// chat texts (raw, messy, as people type them)
const chatText = {
  planAsk: (c) => pick([
    `민지님 ${c.project} 평면도 좀 그려 주세요. 실측 사진은 폴더에 올렸어요`,
    `${c.project} 실측 끝났으니까 평면도 부탁해요~ 고객이 ${int(16, 40)}석 정도 원하심. 사진이랑 치수 메모는 공유폴더 ${c.cust.name} 폴더에`,
    `평면도 요청!! ${c.project} / ${c.area}평 / 카운터 입구쪽 / 화장실 위치 고정. 이번주 안에 가능할까요?`,
    `${c.cust.name} 건 평면도 언제쯤 될까요? 제안서 들어가야 해서요 ㅠ 실측 메모 폴더에 있어요`]),
  planDone: (c, file) => pick([`평면도 공유해요 — ${file}`, `${file} 올렸어요. ${['cafe', 'food', 'edu', 'books'].includes(c.cust.cat) ? '기둥 때문에 좌석 2개 줄었어요' : '기둥 때문에 배치 조금 바꿨어요'} 확인 부탁`,
    `평면도 다 됐어요! ${file} 폴더에 있어요. ${c.cust.cat === 'cafe' || c.cust.cat === 'food' ? '주방 동선만' : '출입구 쪽 동선만'} 한번 봐주세요`, `${c.cust.name} 평면도 끝 ㅎㅎ ${file}`]),
  finAsk: (c, amount) => pick([
    `서연님 ${c.cust.name} 견적 ${won(amount)}원인데 검토 부탁드려요`,
    `${c.project} 견적 검토 좀 ㅠㅠ 합계 ${won(amount)}원(부가세 별도), 고객이 ${pick(['금요일', '이번주', '내일'])}까지 달래요`,
    `재무 검토 요청드려요. ${c.cust.name} / 공급가 ${won(amount)} / 자재비 비중 ${int(40, 60)}% / 견적서는 폴더에 올렸어요`]),
  finOk: (waitDays) => (waitDays >= 1.5 ? pick(['늦어서 미안해요 월말이라.. 단가 두어 개 손봤고 승인했어요', '승인했어요 (늦었죠 ㅠ)']) : pick(['승인했어요', '확인했어요, 승인합니다~', `마진 ${int(18, 30)}% 나오네요. 승인!`])),
  agentPlan: (c, ceil) => {
    const w = (Math.sqrt(c.area * 3.3058) * between(1.1, 1.4)).toFixed(1)
    const d = (c.area * 3.3058 / w).toFixed(1)
    return [`이 실측 치수로 평면도 초안 만들어 줘.`,
      `- 전체 ${w}m x ${d}m, 천장고 ${pick(CEILINGS)}m`,
      `- 출입구는 남측 가운데, 폭 1.2m (양개 아님)`,
      `- ${c.cust.cat === 'cafe' || c.cust.cat === 'food' ? `카운터는 출입구 오른쪽에 길이 3m, 좌석 ${int(16, 40)}석` : c.cust.cat === 'dental' || c.cust.cat === 'clinic' ? `진료실 ${int(2, 5)}개, 상담실 1, 대기실은 창가` : '진열/작업 공간 가벽으로 분리'}`,
      `- 화장실은 기존 위치(북동쪽) 유지. 급배수 이동 불가`,
      `- 창고 3㎡ 정도 확보`,
      `도면은 dxf로, 치수선 넣어서. 벽체 두께 100 기준. 기둥 위치는 실측 사진(공유폴더 ${c.cust.name}) 보고 맞춰 줘.`].join('\n')
  },
  agentReview: (c, file) => pick([`에이전트가 뽑은 평면도 초안인데 치수랑 문 위치 한번만 봐 주세요 ${file}`, `민지님 ${c.cust.name} 평면도 초안 에이전트로 뽑아봤어요. ${file} 손 좀 봐주실 수 있나요?`]),
  agentReviewDone: (file) => pick([`초안에서 화장실 문 방향 반대로 돼 있어서 고쳤어요. ${file} 올림`, `기둥 위치 틀려서 다시 잡았어요 → ${file}`, `수정했어요~ ${file} 카운터 길이 2.4m로 줄임`]),
  agentProposal: (c) => [`${c.cust.name} 제안서 초안 써 줘.`,
    `고객 요구: ${needOf(c)}`,
    `콘셉트는 ${qro(pick(CONCEPTS))}. 톤은 너무 딱딱하지 않게, 고객이 사장님이라 쉬운 말로.`,
    `목차는 우리 제안서 양식대로 (현황 분석 / 콘셉트 / 공간 계획 / 자재·마감 / 일정 / 견적 요약).`,
    `평면도는 공유폴더 ${c.cust.name}/평면도 최신 파일 써 주고, 견적 요약은 비워 둬. 내가 견적서 나오면 채울게.`,
    `hwpx로 저장해 줘.`].join('\n'),
  orderAsk: (c, startDay) => pick([`${c.cust.name} 계약 확정됐어요! 자재 발주 부탁드려요. 목록은 견적서 2번 시트 참고해 주세요`,
    `서연님 ${c.project} 자재 발주 요청 — 타일/조명/목재. 착공 ${md(startDay)} 예정이라 그 전에 입고돼야 해요`]),
  orderDone: (arrive) => pick([`발주 넣었어요. 입고 ${md(arrive)} 예정`, `${pick(SUPPLIERS)} 포함 3곳 발주 완료~ 입고는 ${md(arrive)}`, `발주했어요! 타일 한 품목은 재고 없어서 비슷한 품번으로 넣었어요. 입고 ${md(arrive)}`]),
  schedAsk: (c, startDay) => pick([`${c.project} 시공 일정 조율 부탁해요. 고객은 ${md(startDay)} 전에 착공 원하심`, `민지님 ${c.cust.name} 계약됐어요. 협력업체 일정 좀 맞춰주세요~`]),
  schedDone: (startDay) => pick([`목공·전기 일정 맞췄어요. ${md(startDay)} 착공 가능해요`, `협력업체랑 통화했어요~ ${md(startDay)} 착공으로 공정표 올림`]),
  visitAsk: (c, defect) => pick([`${c.cust.name} 하자 접수됐어요. ${defect.short} 쪽이요. 현장 방문 부탁해요`, `민지님 ${c.cust.name} AS 건 현장 한번 가 주실 수 있을까요? ${defect.short} 문제래요 사진은 메일에`]),
  visitDone: (defect) => pick([`다녀왔어요. ${defect.fix}`, `현장 확인 완료! ${defect.fix.replace(/습니다\.$/, '어요')}`]),
}

// ---------------------------------------------------------------- bundle A
function buildA(c) {
  const k = c.cust, th = c.thread
  let t = c.start
  const amount = c.amount
  c.amounts.push(amount)
  // 1. the customer's request (to 영업, cc the team lead)
  const reqFiles = c.variant === 'bypass' ? [att(`${c.slug}_기존도면.pdf`, 'pdf', 300, 1800)] : chance(0.3) ? [att(`현장사진_${c.slug}.zip`, 'zip', 2000, 9000)] : []
  const req = mail({ at: t, from: k.email, to: [DOYUN], cc: [JIN], subject: c.subj, text: requestText(c, { drawing: c.variant === 'bypass', legal: c.variant === 'legal' }), attachments: reqFiles, thread: th })
  if (!step(c, '요청 메일 접수', DOYUN, t, viaMail(req))) return
  if (chance(0.06)) mail({ at: work(t, 0.3, 3), from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), text: ackText(c), quoted: chance(0.6) ? quote(req) : undefined, thread: th })

  // 2. 현장 실측 — or, in the old way, straight to the plan from the customer's drawing
  let planThread = th, planAskMail = null
  if (c.variant === 'bypass') {
    const at = work(t, 0.5, 5)
    planAskMail = mail({ at, from: DOYUN, to: [MINJI], cc: [JIN], subject: fw(c.subj), quoted: quote(req), attachments: reqFiles,
      text: pick([`민지 님, ${k.name}에서 기존 도면을 보내 주셨어요. 이번 건은 따로 실측 안 하고 이 도면 기준으로 바로 평면도 부탁드려요.`,
        `고객님 도면 첨부합니다. 실측 없이 고객 도면으로 바로 평면도 작업 들어가 주세요. 급한 건이라 이번 주 안에 부탁드려요.`]), thread: th })
    t = at
  } else {
    let fwd = null, sub = th
    const fwdAt = work(t, 0.5, 6)
    const visit = nextBiz(midnight(fwdAt) + int(1, 3) * DAY) + int(13, 16) * HOUR
    if (chance(0.2)) {
      if (chance(0.45)) { sub = `${th}#fw-measure`; c.extra.add(sub) }
      fwd = mail({ at: fwdAt, from: DOYUN, to: [MINJI], cc: [JIN], subject: fw(c.subj), text: measureAsk(c, visit), quoted: quote(req), thread: sub })
    }
    t = Math.max(work(fwd ? fwdAt : t, 6, 26), roundMin(visit + int(60, 200) * MIN))
    if (!isBiz(t) || t - midnight(t) > WORK_END) t = work(t, 0.2, 1)
    const m = mail({ at: t, from: MINJI, to: [DOYUN], cc: [JIN], subject: fwd ? re(fwd.subject) : re(c.subj), text: measureDone(c, t),
      attachments: chance(0.4) ? [att(`실측사진_${c.slug}.zip`, 'zip', 3000, 12000)] : [], quoted: fwd && chance(0.5) ? quote(fwd) : undefined, thread: sub })
    if (!step(c, '현장 실측', MINJI, t, viaMail(m))) return
    planThread = sub
    planAskMail = fwd
  }

  // 3. 평면도 작성 — in mail, or handed over in chat (some with the floor-plan agent drafting first)
  const planFile = `평면도_${c.slug}.dxf`
  if (c.chat === 'plan') {
    const cc = chatCase(c, 'plan')
    const askAt = work(t, 0.3, 4)
    row(cc, { at: askAt, from: DOYUN, to: MINJI, text: chatText.planAsk(c), task: '평면도 작성', act: 'request' })
    t = work(askAt, 4, 20)
    if (!row(cc, { at: t, from: MINJI, to: DOYUN, text: chatText.planDone(c, planFile), task: '평면도 작성', act: 'deliver', artifacts: [planFile] })) { c.open = true; return }
    const s = step(c, '평면도 작성', MINJI, t, { via: 'chat', chatKey: cc.key })
    cc.steps.push({ ...s })
  } else if (c.chat === 'agent-plan') {
    const cc = chatCase(c, 'agent-plan')
    const askAt = work(t, 0.5, 4)
    const back = askAt + int(3, 12) * MIN
    row(cc, { at: askAt, from: DOYUN, to: AGENTS.floorplan.id, agent: true, returnedAt: back, text: chatText.agentPlan(c), task: '평면도 작성', act: 'request' })
    const draft = `평면도_${c.slug}_초안.dxf`
    const revAt = back + int(10, 90) * MIN
    row(cc, { at: revAt, from: DOYUN, to: MINJI, text: chatText.agentReview(c, draft), task: '평면도 작성', act: 'review', artifacts: [draft] })
    t = work(revAt, 2, 12)
    if (!row(cc, { at: t, from: MINJI, to: DOYUN, text: chatText.agentReviewDone(planFile), task: '평면도 작성', act: 'deliver', artifacts: [planFile] })) { c.open = true; return }
    const s = step(c, '평면도 작성', MINJI, t, { via: 'chat', chatKey: cc.key, assist: AGENTS.floorplan.id })
    cc.steps.push({ ...s })
  } else {
    t = work(t, c.variant === 'bypass' ? 3 : 4, c.variant === 'bypass' ? 12 : 20)
    const files = [att(planFile, 'dxf', 80, 420), ...(chance(0.3) ? [att(`평면도_${c.slug}.pdf`, 'pdf', 200, 900)] : [])]
    const text = c.variant === 'bypass'
      ? pick(['보내 주신 도면 기준으로 평면도 그렸어요. 실측은 안 해서 치수는 도면 그대로 따랐습니다. 현장 확인이 필요한 부분은 표시해 두었어요.',
        `고객 도면으로 ${c.project} 평면도 작업했습니다. ${planNote(c)} 치수는 도면 기준이에요.`])
      : planShare(c)
    const m = mail({ at: t, from: MINJI, to: [DOYUN], cc: [JIN], subject: planAskMail ? re(planAskMail.subject) : re(c.subj), text, attachments: files, thread: planThread })
    if (!step(c, '평면도 작성', MINJI, t, viaMail(m))) return
  }

  // 4. 제안서 작성 (the proposal agent drafts it first in a couple of cases)
  t = work(t, 3, 14)
  let propChat = null
  if (c.chat === 'agent-prop') {
    propChat = chatCase(c, 'agent-prop')
    const askAt = work(c.steps[c.steps.length - 1].at, 0.5, 3)
    row(propChat, { at: askAt, from: DOYUN, to: AGENTS.proposal.id, agent: true, returnedAt: askAt + int(4, 15) * MIN, text: chatText.agentProposal(c), task: '제안서 작성', act: 'request' })
    t = Math.max(t, askAt + int(40, 120) * MIN)
  }
  const propFile = `제안서_${c.slug}.hwpx`
  const prop = mail({ at: t, from: DOYUN, to: [JIN], cc: [MINJI], subject: re(c.subj), text: proposalText(c), attachments: [att(propFile, 'hwpx', 60, 320)], thread: th })
  const ps = step(c, '제안서 작성', DOYUN, t, { ...viaMail(prop), ...(propChat ? { chatKey: propChat.key, assist: AGENTS.proposal.id } : {}) })
  if (!ps) return
  if (propChat) propChat.steps.push({ ...ps })
  if (chance(0.05)) mail({ at: work(t, 0.3, 3), from: JIN, to: [DOYUN], cc: [MINJI], subject: re(prop.subject), text: pick(['좋네요. 이대로 진행하세요.', '콘셉트 좋습니다. 3쪽 사진만 밝은 걸로 바꿔 주세요.', '확인했어요. 수고 많았어요.']), quoted: quote(prop), thread: th })

  // 5. 견적서 작성 → [재무 검토] / [법무 검토]
  t = work(t, 1, 8)
  const qFile = `견적서_${c.slug}.xlsx`
  const finance = amount >= 10e6
  let finThread = th, finAsk = null
  if (finance && c.chat !== 'fin') {
    if (chance(0.25)) { finThread = `${th}#fw-finance`; c.extra.add(finThread) }
    const due = nextBiz(midnight(t) + int(2, 4) * DAY)
    finAsk = mail({ at: t, from: DOYUN, to: [SEOYEON], cc: [JIN], subject: finThread === th ? re(c.subj) : fw(c.subj), text: financeAsk(c, amount, due), attachments: [quoteFile(qFile)], quoted: finThread !== th ? quote(req) : undefined, thread: finThread })
    if (!step(c, '견적서 작성', DOYUN, t, viaMail(finAsk))) return
  } else {
    const m = mail({ at: t, from: DOYUN, to: [JIN], subject: re(c.subj), text: quoteInternalText(c, amount, { mentionRule: !finance && chance(0.3), finChat: c.chat === 'fin' }), attachments: [quoteFile(qFile)], thread: th })
    if (!step(c, '견적서 작성', DOYUN, t, viaMail(m))) return
  }
  if (finance) {
    const before = t
    if (c.chat === 'fin') {
      const cc = chatCase(c, 'fin')
      const askAt = t + int(5, 40) * MIN
      row(cc, { at: askAt, from: DOYUN, to: SEOYEON, text: chatText.finAsk(c, amount), task: '재무 검토', act: 'request', artifacts: [qFile] })
      t = work(askAt, 9, 27)
      if (!row(cc, { at: t, from: SEOYEON, to: DOYUN, text: chatText.finOk((t - before) / DAY), task: '재무 검토', act: 'deliver' })) { c.open = true; return }
      const s = step(c, '재무 검토', SEOYEON, t, { via: 'chat', chatKey: cc.key })
      cc.steps.push({ ...s })
    } else {
      t = work(t, 9, 27)
      const m = mail({ at: t, from: SEOYEON, to: [DOYUN], cc: [JIN], subject: re(finAsk.subject), text: financeOk((t - before) / DAY), quoted: chance(0.5) ? quote(finAsk) : undefined, thread: finThread })
      if (!step(c, '재무 검토', SEOYEON, t, viaMail(m))) return
    }
  }
  let legalNote = ''
  if (c.variant === 'legal') {
    const askAt = work(t, 0.3, 3)
    const ask = mail({ at: askAt, from: DOYUN, to: [JIN], subject: re(c.subj), thread: th,
      text: `팀장님, ${k.name}에서 계약 조항 문의가 있어 검토 부탁드립니다. 하자보수 기간과 지체상금, 대금 지급 조건을 물어보셨어요. 견적서는 방금 공유드린 그대로입니다.` })
    t = work(askAt, 4, 18)
    const m = mail({ at: t, from: JIN, to: [DOYUN], subject: re(ask.subject), quoted: quote(ask), thread: th,
      text: '검토했습니다. 하자보수는 준공 후 1년, 지체상금은 하루 0.1%(계약 금액의 10% 한도)로 안내하면 됩니다. 대금은 계약금 30%, 중도금 40%, 잔금 30%로 해 주세요. 표준 계약서 조항 그대로라 따로 고칠 건 없어요.' })
    if (!step(c, '법무 검토', JIN, t, viaMail(m))) return
    legalNote = '문의하신 계약 조항은 하자보수 준공 후 1년, 지체상금 하루 0.1%(계약 금액의 10% 한도), 대금은 계약금 30%·중도금 40%·잔금 30%입니다.'
  }

  // 6. 고객 회신
  t = work(t, 0.5, 5)
  const files = [att(propFile, 'hwpx', 60, 320), quoteFile(qFile), ...(chance(0.3) ? [att(`평면도_${c.slug}.pdf`, 'pdf', 200, 900)] : [])]
  const reply = mail({ at: t, from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), text: replyText(c, amount, { extra: legalNote }), attachments: files, quoted: chance(0.5) ? quote(req) : undefined, thread: th })
  if (!step(c, '고객 회신', DOYUN, t, viaMail(reply))) return
  c.replyAt = t; c.finalReply = t; c.replyMail = reply
}

// the customer asks for changes after the reply: 제안서 → 견적서 → 회신 again (kept under 10,000,000원)
function buildRevision(c) {
  const k = c.cust, th = c.thread
  const cut = pick(CUTS)
  const amount = c.amounts[0] >= 10e6 ? Math.round(between(8.4e6, 9.8e6) / 1e5) * 1e5 : Math.round(c.amounts[0] * between(0.84, 0.95) / 1e5) * 1e5
  let t = custAfter(c.replyAt, 2, 6)
  const ask = mail({ at: t, from: k.email, to: [DOYUN], cc: [JIN], subject: re(c.subj), quoted: quote(c.replyMail), thread: th,
    text: c.amounts[0] >= 10e6
      ? `보내 주신 제안 잘 받아 보았습니다. 전체적으로 마음에 드는데 예산이 1,000만 원 안쪽이라 ${cut.ask} 다시 제안해 주실 수 있을까요? 일정은 그대로 가도 됩니다.`
      : pick([`제안 감사합니다. ${cut.ask} 다시 받아 볼 수 있을까요? 나머지는 좋습니다.`, `내부에서 검토해 봤는데 예산을 조금 줄이고 싶어서요. ${cut.ask} 수정 제안 부탁드립니다.`]) })
  if (!ask) { c.open = true; return }
  c.revision = true
  c.amounts.push(amount)
  t = work(t, 4, 16)
  const prop = mail({ at: t, from: DOYUN, to: [JIN], cc: [MINJI], subject: re(c.subj), text: `${c.project} 수정 제안서 공유드립니다. 고객님 요청대로 ${cut.done}. 평면은 그대로입니다.`, attachments: [att(`제안서_${c.slug}_v2.hwpx`, 'hwpx', 60, 320)], thread: th })
  if (!step(c, '제안서 작성', DOYUN, t, viaMail(prop))) return
  t = work(t, 1, 6)
  const q2 = mail({ at: t, from: DOYUN, to: [JIN], subject: re(c.subj), text: `수정 견적서입니다. 합계 ${amtText(amount)}으로 줄었습니다. 오늘 고객님께 회신하겠습니다.`, attachments: [quoteFile(`견적서_${c.slug}_v2.xlsx`)], thread: th })
  if (!step(c, '견적서 작성', DOYUN, t, viaMail(q2))) return
  t = work(t, 0.5, 4)
  const reply = mail({ at: t, from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), quoted: chance(0.6) ? quote(ask) : undefined, thread: th,
    attachments: [att(`제안서_${c.slug}_v2.hwpx`, 'hwpx', 60, 320), quoteFile(`견적서_${c.slug}_v2.xlsx`)],
    text: `${c.cust.contact} ${title(c)}, 말씀하신 내용 반영해서 수정 제안서와 견적서 다시 보내드립니다. ${cut.done}. 합계는 ${amtText(amount)}입니다. 확인 부탁드립니다.` })
  if (!step(c, '고객 회신', DOYUN, t, viaMail(reply))) return
  c.finalReply = t; c.replyMail = reply
}

// a returning customer: "견적만 다시 주세요" (quantity/material change) → 견적서 → [재무] → 회신
function buildRequote(c, base) {
  const k = c.cust, th = c.thread
  const ch = pick(CHANGES.filter((x) => !x.cats || x.cats.includes(k.cat)))
  const amount = Math.round(base.amounts[base.amounts.length - 1] * between(...ch.f) / 1e5) * 1e5
  c.amounts.push(amount)
  let t = c.start
  const req = mail({ at: t, from: k.email, to: [DOYUN], cc: [JIN], subject: c.subj, quoted: quote(base.replyMail), thread: th,
    text: pick([`이도윤 님 안녕하세요, ${k.name} ${k.contact}입니다. 지난번 견적에서 ${ch.ask} 견적만 다시 받을 수 있을까요? 설계는 그대로 가도 될 것 같아요.`,
      `안녕하세요. 지난번에 받은 ${c.project} 견적 관련해서요, ${ch.ask} 다시 견적 주실 수 있을까요? 수량만 바뀌는 거라 제안서는 그대로면 됩니다.`,
      `견적만 다시 주세요. ${ch.ask} 계산해 주시면 됩니다. 감사합니다.`]) })
  if (!step(c, '요청 메일 접수', DOYUN, t, viaMail(req))) return
  t = work(t, 3, 16)
  const qFile = `견적서_${c.slug}_재견적.xlsx`
  const finance = amount >= 10e6
  let finAsk = null
  if (finance) {
    finAsk = mail({ at: t, from: DOYUN, to: [SEOYEON], cc: [JIN], subject: re(c.subj), text: financeAsk(c, amount, nextBiz(midnight(t) + 2 * DAY), `${k.name} 재견적(${ch.short})`), attachments: [quoteFile(qFile)], thread: th })
    if (!step(c, '견적서 작성', DOYUN, t, viaMail(finAsk))) return
    const before = t
    t = work(t, 9, 27)
    const m = mail({ at: t, from: SEOYEON, to: [DOYUN], cc: [JIN], subject: re(c.subj), text: financeOk((t - before) / DAY), thread: th })
    if (!step(c, '재무 검토', SEOYEON, t, viaMail(m))) return
  } else {
    const m = mail({ at: t, from: DOYUN, to: [JIN], subject: re(c.subj), text: `${k.name} 재견적입니다. ${ch.short} 반영해서 합계 ${amtText(amount)}으로 바뀌었습니다. ${pick(['바로 회신드리겠습니다.', '설계는 지난번과 같습니다.', ''])}`.trim(), attachments: [quoteFile(qFile)], thread: th })
    if (!step(c, '견적서 작성', DOYUN, t, viaMail(m))) return
  }
  t = work(t, 0.5, 4)
  const reply = mail({ at: t, from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), quoted: chance(0.5) ? quote(req) : undefined, thread: th, attachments: [quoteFile(qFile)],
    text: `${k.contact} ${title(c)}, 요청하신 대로 ${ch.short} 반영한 견적서 다시 보내드립니다. 합계 ${amtText(amount)}입니다. 설계안은 지난번과 같습니다.` })
  if (!step(c, '고객 회신', DOYUN, t, viaMail(reply))) return
  c.finalReply = t; c.replyMail = reply
}

// ---------------------------------------------------------------- bundle B: 계약 확정 → {자재 발주 ∥ 시공 일정 조율} → 착공 안내
function buildB(c) {
  const k = c.cust, th = c.thread
  let t = c.start
  const trig = !chance(0.6) ? null : mail({ at: t, from: k.email, to: [DOYUN], cc: [JIN], subject: c.subj, thread: th, attachments: [att(`공사계약서_${c.slug}_날인.pdf`, 'pdf', 300, 1200)],
    text: pick([`이도윤 님, 보내 주신 제안대로 진행하겠습니다. 날인한 계약서 첨부드리고 계약금은 오늘 입금했습니다.`,
      `안녕하세요, ${k.name} ${k.contact}입니다. 내부 검토 끝나서 계약 진행하려고 합니다. 날인본 첨부하니 확인 부탁드려요.`]) })
  t = work(t, 2, 12)
  const conf = mail({ at: t, from: DOYUN, to: [k.email], cc: [JIN], subject: trig ? re(c.subj) : c.subj, quoted: trig && chance(0.5) ? quote(trig) : undefined, thread: th,
    attachments: trig ? [] : [att(`공사계약서_${c.slug}.pdf`, 'pdf', 300, 1200)],
    text: trig ? `${k.contact} ${title(c)}, 날인하신 계약서와 계약금 입금 확인했습니다. ${c.project} 공사 계약이 확정되었습니다. 착공 일정은 자재와 협력업체 일정을 맞춘 뒤 바로 안내드리겠습니다.`
      : `${k.contact} ${title(c)}, 통화로 말씀 주신 대로 ${c.project} 공사 계약을 확정했습니다. 계약서 사본 첨부드리며, 계약금 입금도 확인했습니다. 착공 일정은 정리되는 대로 안내드리겠습니다.` })
  if (!step(c, '계약 확정', DOYUN, t, viaMail(conf))) return
  const confAt = t
  const startDay = nextBiz(midnight(confAt) + int(7, 12) * DAY)
  const chat = c.chat ? chatCase(c, c.chat) : null
  const parts = []
  // 자재 발주 (재무)
  {
    let oAt = work(confAt, 4, 24)
    const arrive = nextBiz(startDay - int(2, 4) * DAY)
    if (c.chat === 'order' || c.chat === 'both') {
      const askAt = work(confAt, 0.2, 2)
      oAt = Math.max(oAt, askAt + 2 * HOUR)
      row(chat, { at: askAt, from: DOYUN, to: SEOYEON, text: chatText.orderAsk(c, startDay), task: '자재 발주', act: 'request' })
      parts.push({ at: oAt, task: '자재 발주', who: SEOYEON, chatRow: { at: oAt, from: SEOYEON, to: DOYUN, text: chatText.orderDone(arrive), task: '자재 발주', act: 'deliver' } })
    } else {
      let sub = th, ask = null
      if (chance(0.35)) {
        const askAt = work(confAt, 0.2, 2)
        oAt = Math.max(oAt, askAt + 2 * HOUR)
        if (chance(0.4)) { sub = `${th}#fw-order`; c.extra.add(sub) }
        ask = { at: askAt, from: DOYUN, to: [SEOYEON], cc: [JIN], subject: fw(c.subj), quoted: quote(conf), thread: sub, attachments: [att(`자재목록_${c.slug}.xlsx`, 'xlsx', 12, 26)],
          text: `서연 님, ${c.project} 계약 확정되었습니다. 견적서 기준으로 자재 발주 부탁드립니다. 착공은 ${md(startDay)}쯤으로 보고 있어요.` }
      }
      parts.push({ at: oAt, task: '자재 발주', who: SEOYEON, ask, mail: { from: SEOYEON, to: [DOYUN], cc: [JIN], thread: sub, reSubject: ask ? null : c.subj,
        text: pick([`${pick(SUPPLIERS)} 등 세 곳에 타일·조명·목재 발주 넣었습니다. 입고 예정일은 ${md(arrive)}입니다.`,
          `${c.project} 자재 발주 완료했습니다. 타일 한 품목은 재고가 없어 같은 규격의 다른 품번으로 넣었어요. 입고는 ${md(arrive)} 예정입니다.`]) } })
    }
  }
  // 시공 일정 조율 (디자이너)
  {
    let sAt = work(confAt, 4, 24)
    if (c.chat === 'schedule' || c.chat === 'both') {
      const askAt = work(confAt, 0.2, 2) + int(1, 20) * MIN
      sAt = Math.max(sAt, askAt + 2 * HOUR)
      row(chat, { at: askAt, from: DOYUN, to: MINJI, text: chatText.schedAsk(c, startDay), task: '시공 일정 조율', act: 'request' })
      parts.push({ at: sAt, task: '시공 일정 조율', who: MINJI, chatRow: { at: sAt, from: MINJI, to: DOYUN, text: chatText.schedDone(startDay), task: '시공 일정 조율', act: 'deliver', artifacts: [`공정표_${c.slug}.xlsx`] } })
    } else {
      let ask = null
      if (chance(0.2)) {
        const askAt = work(confAt, 0.2, 2) + int(1, 20) * MIN
        sAt = Math.max(sAt, askAt + 2 * HOUR)
        ask = { at: askAt, from: DOYUN, to: [MINJI], cc: [JIN], subject: fw(c.subj), quoted: quote(conf), thread: th,
          text: `민지 님, ${c.project} 시공 일정 조율 부탁드려요. 고객님은 ${md(startDay)} 전후면 괜찮다고 하십니다.` }
      }
      const endDay = nextBiz(startDay + int(14, 30) * DAY)
      parts.push({ at: sAt, task: '시공 일정 조율', who: MINJI, ask, mail: { from: MINJI, to: [DOYUN], cc: [JIN], thread: th, reSubject: ask ? null : c.subj,
        attachments: [att(`공정표_${c.slug}.xlsx`, 'xlsx', 14, 30)],
        text: `목공·전기·도장 협력업체와 일정 맞췄습니다. ${md(startDay)} 착공, ${md(endDay)} 준공 예정이고 공정표 첨부합니다.` } })
    }
  }
  if (parts[0].at === parts[1].at) parts[1].at += int(7, 50) * MIN
  for (const p of parts) if (p.chatRow) p.chatRow.at = p.at
  // the requests first, then the two results in the order they happened
  const asks = parts.filter((p) => p.ask).map((p) => p.ask).sort((a, b) => a.at - b.at)
  const askMails = new Map()
  for (const a of asks) askMails.set(a, mail(a))
  let open = false
  for (const p of [...parts].sort((a, b) => a.at - b.at)) {
    if (open) break
    if (p.chatRow) {
      if (!row(chat, p.chatRow)) { c.open = true; open = true; break }
      const s = step(c, p.task, p.who, p.at, { via: 'chat', chatKey: chat.key })
      if (!s) { open = true; break }
      chat.steps.push({ ...s })
    } else {
      const askMail = p.ask ? askMails.get(p.ask) : null
      const m = mail({ at: p.at, from: p.mail.from, to: p.mail.to, cc: p.mail.cc, thread: p.mail.thread, attachments: p.mail.attachments || [],
        subject: askMail ? re(askMail.subject) : re(p.mail.reSubject), text: p.mail.text, quoted: askMail && chance(0.4) ? quote(askMail) : undefined })
      if (!step(c, p.task, p.who, p.at, viaMail(m))) { open = true; break }
    }
  }
  if (open) return
  t = work(Math.max(parts[0].at, parts[1].at), 2, 14)
  const weeks = int(2, 5)
  const notice = mail({ at: t, from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), thread: th,
    text: `${k.contact} ${title(c)}, ${c.project} 착공 일정 안내드립니다. ${md(startDay)}에 착공해 약 ${weeks}주 동안 공사합니다. 철거처럼 소음이 큰 작업은 첫 이틀에 몰아서 진행하겠습니다. 건물 관리사무소 공사 신고는 저희가 해 두겠습니다.` })
  if (!step(c, '착공 안내', DOYUN, t, viaMail(notice))) return
  c.startDay = startDay; c.endDay = startDay + weeks * 7 * DAY
}

// ---------------------------------------------------------------- bundle C: 하자 접수 → 현장 방문 → 처리 보고
function buildC(c) {
  const k = c.cust, th = c.thread
  const defect = pick(DEFECTS)
  let t = c.start
  const req = mail({ at: t, from: k.email, to: [DOYUN], cc: [JIN], subject: c.subj, thread: th, attachments: [att(`하자사진_${int(1, 9)}.jpg`, 'jpg', 800, 4200)],
    text: `${pick(['이도윤 님, 안녕하세요.', '안녕하세요, ' + k.name + ' ' + k.contact + '입니다.', '수고 많으십니다.'])} 공사 끝나고 잘 쓰고 있는데 ${defect.d} 사진 첨부드리니 확인 한번 부탁드립니다.` })
  if (!step(c, '하자 접수', DOYUN, t, viaMail(req))) return
  const visit = nextBiz(midnight(t) + int(1, 3) * DAY) + int(10, 15) * HOUR
  if (chance(0.3)) mail({ at: work(t, 0.3, 3), from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), thread: th, quoted: quote(req),
    text: `하자 접수했습니다. 담당 디자이너가 ${md(visit)} ${hm(visit)}에 방문해 확인하겠습니다. 불편을 드려 죄송합니다.` })
  t = Math.max(work(t, 5, 20), visit + int(60, 180) * MIN)
  if (c.chat) {
    const cc = chatCase(c, 'visit')
    row(cc, { at: work(c.start, 0.2, 2), from: DOYUN, to: MINJI, text: chatText.visitAsk(c, defect), task: '현장 방문', act: 'request' })
    if (!row(cc, { at: t, from: MINJI, to: DOYUN, text: chatText.visitDone(defect), task: '현장 방문', act: 'deliver' })) { c.open = true; return }
    const s = step(c, '현장 방문', MINJI, t, { via: 'chat', chatKey: cc.key })
    cc.steps.push({ ...s })
  } else {
    const m = mail({ at: t, from: MINJI, to: [DOYUN], cc: [JIN], subject: re(c.subj), thread: th, attachments: [att(`보수전후_${c.slug}.zip`, 'zip', 2000, 8000)],
      text: `${c.project} 하자 현장 다녀왔습니다. ${defect.fix} 보수 전후 사진 첨부합니다.` })
    if (!step(c, '현장 방문', MINJI, t, viaMail(m))) return
  }
  t = work(t, 1, 6)
  const rep = mail({ at: t, from: DOYUN, to: [k.email], cc: [JIN], subject: re(c.subj), thread: th,
    text: `${k.contact} ${title(c)}, 말씀하신 ${defect.short} 건 처리 결과 보고드립니다. ${defect.fix} 하자보수 기간 안이라 비용은 없습니다. 불편을 드려 죄송합니다.` })
  if (!step(c, '처리 보고', DOYUN, t, viaMail(rep))) return
}

// ---------------------------------------------------------------- the 90 days
const custs = shuffle(CUSTOMERS)
const N_BYPASS = 5
const N_NORMAL_USED = 45
const base = []
for (let i = 0; i < N_BYPASS + N_NORMAL_USED; i++) {
  const cust = custs[i]
  const bypass = i < N_BYPASS
  const startDay = bypass ? day('2026-08-12') + int(0, 14) * DAY : day('2026-08-12') + int(0, 84) * DAY
  const p = projectFor(cust)
  base.push({ cust, ...p, slug: slugOf(p.project), loc: pick(LOCATIONS), area: int(...AREA[cust.cat]), start: custTime(startDay), variant: bypass ? 'bypass' : 'normal', big: false })
}
base.sort((a, b) => a.start - b.start)
// the one legal-review case: a small quote, mid-window
const legalPick = base.filter((b) => b.variant === 'normal' && b.start >= day('2026-09-07') && b.start <= day('2026-10-10'))
const legal = legalPick[int(0, legalPick.length - 1)]
legal.variant = 'legal'
// 재무 검토 for about 40% of the A cases: an exact share of the base cases gets a quote of 10,000,000원 or more
for (const b of shuffle(base.filter((x) => x !== legal)).slice(0, 21)) b.big = true
// internal steps that happen in chat instead of mail (cases far enough from the end to get there)
const chatPool = shuffle(base.filter((b) => b.variant === 'normal' && b.start <= day('2026-10-30')))
const takeChat = (n, kind, ok = () => true) => { let k = 0; for (const b of chatPool) { if (k >= n) break; if (!b.chat && ok(b)) { b.chat = kind; k++ } } }
takeChat(6, 'fin', (b) => b.big)
takeChat(8, 'plan')
takeChat(4, 'agent-plan')
takeChat(2, 'agent-prop')
for (const b of base) {
  b.amount = amountFor(b.big)
  const c = newCase({ bundle: 'A', ...b, thread: `A${String(cases.length + 1).padStart(3, '0')}` })
  c.subj = requestSubject(c)
  buildA(c)
}
const baseCases = [...cases]
// the bypass is the old way: never after 09-05 (asserted below)

// revision loops: closed, not too big, early enough to go round again
const revisionPool = shuffle(baseCases.filter((c) => c.variant === 'normal' && c.replyAt && c.replyAt <= day('2026-10-22') && c.amounts[0] <= 16e6))
for (const c of revisionPool.slice(0, 7)) { c.variant = 'revision'; buildRevision(c) }

// re-quotes: returning customers some weeks after their reply
const requotePool = shuffle(baseCases.filter((c) => c.variant !== 'revision' && c.variant !== 'legal' && c.finalReply && c.finalReply <= day('2026-10-20')))
const requoted = new Set()
for (const b of requotePool.slice(0, 9)) {
  const latest = Math.min(b.finalReply + int(10, 30) * DAY, day('2026-11-04'))
  const c = newCase({ bundle: 'A', variant: 'requote', cust: b.cust, project: b.project, branch: b.branch, phrase: b.phrase, slug: b.slug, loc: b.loc, area: b.area,
    start: custTime(Math.max(midnight(b.finalReply) + 7 * DAY, midnight(latest))), thread: `Q${String(cases.length + 1).padStart(3, '0')}`, of: b.key })
  c.subj = pick([`[${b.cust.name}] 견적 다시 부탁드립니다`, `${b.project} 재견적 요청`, `견적만 다시 받을 수 있을까요 (${b.project})`])
  buildRequote(c, b)
  requoted.add(b.key)
}

// contracts: customers who said yes
const contractPool = shuffle(baseCases.filter((c) => !requoted.has(c.key) && c.finalReply && c.finalReply <= day('2026-10-20') && c.variant !== 'legal'))
const contracts = []
const B_CHAT = ['order', 'order', 'order', 'order', 'schedule', 'schedule', 'both', 'both']
for (const [i, b] of contractPool.slice(0, 14).entries()) {
  const c = newCase({ bundle: 'B', variant: 'contract', cust: b.cust, project: b.project, branch: b.branch, slug: b.slug, loc: b.loc,
    start: custAfter(b.finalReply, 3, 12), thread: `B${String(cases.length + 1).padStart(3, '0')}`, of: b.key, chat: B_CHAT[i] || null })
  c.subj = pick([`[${b.cust.name}] ${b.project} 공사 계약 진행`, `${b.project} 계약 관련`, `[계약] ${b.project}`])
  buildB(c)
  contracts.push(c)
}

// defects after construction
const defectPool = shuffle(contracts.filter((c) => c.startDay && c.endDay && c.endDay <= day('2026-10-24')))
for (const [i, b] of defectPool.slice(0, 3).entries()) {
  const c = newCase({ bundle: 'C', variant: 'defect', cust: b.cust, project: b.project, slug: b.slug,
    start: custTime(Math.min(b.endDay + int(5, 14) * DAY, day('2026-11-05'))), thread: `C${String(cases.length + 1).padStart(3, '0')}`, of: b.key, chat: i < 2 })
  c.subj = pick([`[${b.cust.name}] 하자 보수 요청드립니다`, `${b.project} 시공 후 하자 문의`, `[AS 요청] ${b.project}`])
  buildC(c)
}

// ---------------------------------------------------------------- noise: newsletters, no-reply notices, invites, other work mail
const NEWSLETTERS = [
  { from: 'news@interior-weekly.example', name: '인테리어 위클리', subj: (t) => `[인테리어 위클리] ${new Date(t).getUTCMonth() + 1}월 자재 가격 동향과 현장 소식`,
    text: () => pick(['이번 주 포세린 타일과 합판 가격이 소폭 올랐습니다. 상업 공간에서는 3000K 간접 조명이 강세입니다. 자세한 내용은 본문 링크에서 확인하세요.',
      '수입 원목 가격이 2주 연속 내렸습니다. 소형 매장 리모델링 수요는 지난달보다 늘었습니다. 구독 설정은 아래 링크에서 바꿀 수 있습니다.']) },
  { from: 'letter@build-expo.example', name: '건축·인테리어 박람회', subj: () => pick(['2026 건축·인테리어 박람회 사전 등록 안내', '[박람회] 사전 등록 마감 D-7', '박람회 참가 기업 세미나 일정 공개']),
    text: () => '올해 박람회는 4일간 열립니다. 사전 등록하시면 무료로 입장할 수 있습니다. 이 메일은 수신 동의하신 분께 발송됩니다.' },
  { from: 'promo@office-mall.example', name: '오피스몰', subj: () => pick(['[오피스몰] 이번 주 사무용품 최대 30% 할인', '[오피스몰] 복합기 토너 1+1 행사', '[광고] 오피스몰 가을 정기 세일']),
    text: () => '이번 주 한정으로 사무용품을 특가에 드립니다. 3만 원 이상 구매 시 무료 배송입니다. 수신을 원하지 않으시면 수신 거부를 눌러 주세요.' },
  { from: 'newsletter@designtalk.example', name: '디자인톡', subj: () => pick(['디자인톡 뉴스레터 — 작은 상업공간 조명 트렌드', '디자인톡 — 10평 매장 동선 설계 사례 5가지', '디자인톡 — 친환경 마감재 고르는 법']),
    text: () => '작은 공간일수록 조명 계획이 공간 인상을 좌우합니다. 이번 호에서는 실제 사례 세 가지를 소개합니다. 끝까지 읽어 주셔서 감사합니다.' },
]
const NOREPLY = [
  { from: 'no-reply@tax-invoice.example', name: '전자세금계산서', subj: () => `[전자세금계산서] ${pick(SUPPLIERS)}에서 세금계산서가 발행되었습니다`,
    text: () => { const n = Math.round(between(3e5, 4e6) / 1e4) * 1e4; return `공급가액 ${won(n)}원, 세액 ${won(n / 10)}원의 전자세금계산서가 발행되었습니다. 이 메일은 발신 전용입니다.` } },
  { from: 'no-reply@parcel.example', name: '택배 알림', subj: () => '[배송 완료] 주문하신 상품이 도착했습니다', text: () => '고객님의 상품이 배송 완료되었습니다. 이 메일은 발신 전용이라 회신할 수 없습니다.' },
  { from: 'no-reply@cloud-drive.example', name: '클라우드 드라이브', subj: () => `공유 폴더 '고객 자료'에 새 파일 ${int(2, 6)}개가 추가되었습니다`, text: () => '공유 폴더에 새 파일이 추가되었습니다. 드라이브에서 확인하세요. 알림 설정은 계정 설정에서 바꿀 수 있습니다.' },
  { from: 'no-reply@card.example', name: '법인카드 알림', subj: () => '[법인카드] 결제 승인 안내', text: () => `${won(Math.round(between(1e4, 6e5) / 100) * 100)}원 결제가 승인되었습니다. 본인이 사용하지 않았다면 고객센터로 연락 주세요.` },
  { from: 'no-reply@account.example', name: '계정 보안', subj: () => '새 기기에서 로그인했습니다', text: () => '새 기기에서 계정에 로그인했습니다. 본인이 맞다면 이 메일은 무시하셔도 됩니다.' },
]
const PEOPLE_EXTRA = {}
function noise() {
  // newsletters: weekly-ish, early morning
  let i = 0
  for (let d = FROM + int(0, 3) * DAY; d <= TO; d += int(5, 7) * DAY) {
    const n = NEWSLETTERS[i++ % NEWSLETTERS.length]
    const at = roundMin(midnight(d) + between(6.5, 8.5) * HOUR)
    PEOPLE_EXTRA[n.from] = { name: n.name, role: '뉴스레터' }
    const domain = n.from.split('@')[1]
    mail({ at, from: n.from, to: [JIN], subject: n.subj(at), text: n.text(), kind: 'newsletter', thread: `N${i}`,
      headers: { 'list-unsubscribe': `<mailto:unsubscribe@${domain}>, <https://${domain}/unsubscribe?u=ax${String(i).padStart(3, '0')}>` } })
  }
  for (let j = 0; j < 14; j++) {
    const n = NOREPLY[j % NOREPLY.length]
    const at = roundMin(FROM + int(0, 89) * DAY + between(7, 22) * HOUR)
    PEOPLE_EXTRA[n.from] = { name: n.name, role: '자동 알림' }
    mail({ at, from: n.from, to: [JIN], subject: n.subj(), text: n.text(), kind: 'noreply', thread: `R${j}` })
  }
  const INVITES = [
    [DOYUN, () => `${pick(baseCases).project} 현장 미팅`, '현장'],
    [SEOYEON, () => '월말 정산 회의', '3층 회의실'],
    [JIN, () => '주간 영업 회의', '2층 회의실'],
    [MINJI, () => '협력업체 공정 회의', '온라인'],
  ]
  for (let j = 0; j < 10; j++) {
    const [from, what, where] = INVITES[j % INVITES.length]
    const sent = work(FROM + int(0, 86) * DAY, 0, 9)
    const when = nextBiz(midnight(sent) + int(1, 5) * DAY) + int(10, 16) * HOUR
    const d = new Date(when)
    const w = what()
    const others = [JIN, DOYUN, MINJI, SEOYEON].filter((e) => e !== from)
    mail({ at: sent, from, to: others, subject: `초대: ${w} @ ${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 (${WD[d.getUTCDay()]}) ${hm(when)}~${hm(when + HOUR)}`,
      text: `${nameOf(from)} 님이 일정에 초대했습니다. 일시: ${md(when)} ${hm(when)}, 장소: ${where}. 참석 여부를 알려 주세요.`, kind: 'invite', attachments: [att('invite.ics', 'ics', 1, 3)], thread: `I${j}` })
  }
  // other work mail that belongs to no case
  const SUP = [
    { from: 'sales@garam-tile.example', name: '가람타일 영업팀', subject: '11월 타일 단가표 송부드립니다', text: '안녕하세요, 가람타일입니다. 11월 단가표 보내드립니다. 포세린 600각 일부 품목이 5% 인상되었으니 참고 부탁드립니다.', file: '가람타일_11월_단가표.xlsx' },
    { from: 'order@bitna-light.example', name: '빛나조명', subject: '[빛나조명] 가을 신제품 카탈로그', text: '가을 신제품 카탈로그를 보내드립니다. 매장용 트랙 조명 신모델이 추가되었습니다. 샘플이 필요하시면 회신 주세요.', file: '빛나조명_카탈로그_2026FW.pdf' },
    { from: 'info@mokhyang-wood.example', name: '목향목재', subject: '원목 합판 입고 지연 안내', text: '수입 원목 합판 입고가 1주일 정도 늦어질 예정입니다. 발주하신 건은 순서대로 출고하겠습니다. 양해 부탁드립니다.' },
  ]
  for (const [j, s] of SUP.entries()) {
    PEOPLE_EXTRA[s.from] = { name: s.name, role: '거래처' }
    mail({ at: work(FROM + int(5, 85) * DAY, 0, 9), from: s.from, to: [JIN], cc: j === 0 ? [SEOYEON] : [], subject: s.subject, text: s.text, attachments: s.file ? [att(s.file, s.file.endsWith('.pdf') ? 'pdf' : 'xlsx', 20, 2400)] : [], thread: `S${j}` })
  }
  const INTERNAL = [
    { at: day('2026-08-28'), from: SEOYEON, to: [JIN, DOYUN, MINJI], subject: '8월 법인카드 정산 마감 안내', text: '8월 법인카드 사용 내역은 9/2(수)까지 정산 부탁드립니다. 영수증 사진은 공유 폴더 정산 폴더에 올려 주세요.' },
    { at: day('2026-09-29'), from: SEOYEON, to: [JIN, DOYUN, MINJI], subject: '9월 정산 마감 안내 (연휴로 하루 늦춤)', text: '추석 연휴 때문에 9월 정산 마감을 10/2(금)로 하루 늦춥니다. 늦어도 그날 오전까지 부탁드려요.' },
    { at: day('2026-09-15'), from: MINJI, to: [JIN, DOYUN, SEOYEON], subject: '공유 폴더 정리 안내', text: '고객별 폴더 이름을 「고객명_공사명」으로 맞췄어요. 실측 사진은 각 폴더 안 「실측」 폴더에 넣어 주세요.' },
    { at: day('2026-10-30'), from: DOYUN, to: [JIN], subject: '10월 영업 현황 정리', text: '10월 문의와 회신 현황 정리했습니다. 견적 회신까지 평균 일주일 정도 걸렸고, 재무 검토 대기가 가장 길었습니다. 자세한 건 첨부 파일 봐 주세요.', file: '10월_영업현황.xlsx' },
    { at: day('2026-10-13'), from: JIN, to: [DOYUN, MINJI, SEOYEON], subject: '11월 워크숍 일정', text: '11월 워크숍은 11/20(금)로 잡았습니다. 올해 진행한 현장 사례 하나씩 준비해 주세요.' },
  ]
  for (const [j, m] of INTERNAL.entries()) mail({ at: work(m.at, 0, 8), from: m.from, to: m.to, subject: m.subject, text: m.text, attachments: m.file ? [att(m.file, 'xlsx', 20, 60)] : [], thread: `W${j}` })
}
noise()

// ---------------------------------------------------------------- work at set times (design-v0.3 §15)
// 이도윤's weekly site report to 모아 공유오피스 (cc 장진영) every Monday morning, from the week after the customer asked for it
// and he said when — the dates keep a weekly clock and the mails say so; once a day late after the 추석 week. 박서연's closing
// report on the 1st of each month: three in 90 days is too few for the dates alone, the mails' own words make it a timer.
// A stream of its own, so the mail above stays the same byte for byte.
const SET_TIMES = []
{
  const r2 = mulberry32(20261113)
  const jit = (a, b) => Math.round((a + r2() * (b - a)) / MIN) * MIN
  const MOA = 'hyun.ng@moa-office.example'
  const ask = mail({ at: day('2026-09-03') + 10 * HOUR + jit(0, 40 * MIN), from: MOA, to: [DOYUN], cc: [JIN], subject: '[모아 공유오피스] 공사 기간 주간 공정 보고 요청', thread: 'P0', kind: 'work',
    text: '공사가 시작됐으니 준공 때까지 매주 월요일 오전에 주간 공정 보고서를 메일로 보내 주세요. 공정률과 이번 주 한 일, 다음 주 일정, 현장 사진 몇 장이면 됩니다.' })
  mail({ at: day('2026-09-03') + 14 * HOUR + jit(0, 50 * MIN), from: DOYUN, to: [MOA], cc: [JIN], subject: re(ask.subject), thread: 'P0', kind: 'work', quoted: quote(ask),
    text: '네, 다음 주부터 매주 월요일 오전 9시 반까지 주간 공정 보고서를 보내 드리겠습니다. 양식은 첨부와 같이 공정률 · 이번 주 · 다음 주 · 특이 사항 순서입니다.',
    attachments: [att('주간공정보고_양식.xlsx', 'xlsx', 12, 16, { file: 'ax-demo-templates/주간공정보고_양식.xlsx' })] })
  const DONE = ['철거와 바닥 수평 작업', '전기 배선과 설비 배관', '천장 틀과 경량 벽체', '석고보드와 퍼티', '바닥재 시공', '도장과 벽지', '조명 · 콘센트 설치', '가구 반입과 설치', '부분 마감 보수', '준공 청소와 점검']
  let k = 0
  for (let d = day('2026-09-07'); d <= day('2026-11-09'); d += 7 * DAY, k++) {
    const late = ymd(d) === '2026-09-28' // the Monday after 추석: a day late
    const at = d + (late ? DAY : 0) + 9 * HOUR + jit(5 * MIN, 38 * MIN)
    const pct = Math.min(100, Math.round(((k + 1) / DONE.length) * 100))
    const mmdd = `${String(new Date(at).getUTCMonth() + 1).padStart(2, '0')}${String(new Date(at).getUTCDate()).padStart(2, '0')}`
    mail({ at, from: DOYUN, to: [MOA], cc: [JIN], subject: `[주간 공정 보고] 모아 공유오피스 ${md(at)}`, thread: `P${k + 1}`, kind: 'work',
      text: `${late ? '추석 연휴 뒤라 하루 늦었습니다. ' : ''}이번 주 공정 보고드립니다. 공정률 ${pct}%, 이번 주에는 ${DONE[k]}${k + 1 < DONE.length ? `을 마쳤고 다음 주에는 ${DONE[k + 1]} 진행 예정입니다` : '까지 마쳤습니다'}. 자세한 내용은 첨부 파일을 봐 주세요.`,
      attachments: [att(`주간공정보고_모아공유오피스_${mmdd}.xlsx`, 'xlsx', 40, 90, { file: 'ax-demo-templates/주간공정보고_양식.xlsx' })] })
  }
  SET_TIMES.push({ task: '주간 공정 보고', who: DOYUN, role: '영업', cron: '0 9 * * 1', mails: k, says: '매주 월요일 오전 9시 반까지' })
  for (const [i, s] of ['2026-09-01', '2026-10-01', '2026-11-02'].entries()) {
    const at = day(s) + 9 * HOUR + jit(10 * MIN, 50 * MIN)
    const m = new Date(at).getUTCMonth() // the month just closed (getUTCMonth is 0-based: September's mail closes 8월)
    mail({ at, from: SEOYEON, to: [JIN], cc: [DOYUN], subject: `${m}월 결산 보고`, thread: `F${i}`, kind: 'work',
      text: `${m}월 결산 보고드립니다. 매월 1일 오전에 지난달 매출 · 매입 · 미수금을 정리해 보내 드리고 있습니다. 미수금이 있는 현장은 첨부 파일의 비고를 봐 주세요.`,
      attachments: [att(`월결산_2026-${String(m).padStart(2, '0')}.xlsx`, 'xlsx', 30, 60, { file: 'ax-demo-templates/월결산_양식.xlsx' })] })
  }
  SET_TIMES.push({ task: '월 결산 보고', who: SEOYEON, role: '재무 담당', cron: '0 9 1 * *', mails: 3, says: '매월 1일 오전에' })
}

// ---------------------------------------------------------------- ids, threads and the file
mails.sort((a, b) => a.at - b.at || a.key - b.key)
const idOfKey = new Map(), threadIds = new Map()
mails.forEach((m, i) => {
  idOfKey.set(m.key, `m${String(i + 1).padStart(4, '0')}`)
  if (!threadIds.has(m.thread)) threadIds.set(m.thread, `t${String(threadIds.size + 1).padStart(4, '0')}`)
})
// (a chat case whose first handover would fall after the window never happened; rows in time order)
for (let i = chatCases.length - 1; i >= 0; i--) if (!chatCases[i].rows.length) chatCases.splice(i, 1)
for (const cc of chatCases) cc.rows.sort((a, b) => a.at - b.at)
chatCases.sort((a, b) => a.rows[0].at - b.rows[0].at || a.key - b.key)
const chatIdOf = new Map(chatCases.map((cc, i) => [cc.key, `chat:ax-demo:${String(i + 1).padStart(4, '0')}`]))

const outMails = mails.map((m) => ({
  id: idOfKey.get(m.key), thread: threadIds.get(m.thread), date: iso(m.at), from: m.from, to: m.to, cc: m.cc, subject: m.subject, text: m.text,
  ...(m.quoted ? { quoted: m.quoted } : {}), attachments: m.attachments, labels: m.from === OWNER ? ['SENT'] : ['INBOX'],
  ...(m.headers ? { headers: m.headers } : {}), kind: m.kind,
}))
const outStep = (s) => ({ task: s.task, who: s.who, at: iso(s.at), ...(s.mailKey ? { mail: idOfKey.get(s.mailKey) } : {}), ...(s.via ? { via: s.via } : {}),
  ...(s.chatKey ? { chat_case: chatIdOf.get(s.chatKey) } : {}), ...(s.assist ? { assist: s.assist } : {}) })
const keyToCase = new Map(cases.map((c) => [c.key, c]))
const truthCases = cases.filter((c) => c.steps.length).map((c) => ({
  thread: threadIds.get(c.thread), bundle: c.bundle, variant: c.variant, customer: c.cust.name, project: c.project,
  ...(c.extra.size ? { extra_threads: [...c.extra].map((x) => threadIds.get(x)).filter(Boolean) } : {}),
  ...(c.amounts.length ? { amounts: c.amounts } : {}), ...(c.of ? { follows: threadIds.get(keyToCase.get(c.of).thread) } : {}),
  ...(c.open ? { open: true } : {}), steps: c.steps.map(outStep),
})).sort((a, b) => a.thread.localeCompare(b.thread))
const truthChat = chatCases.map((cc) => ({
  case_id: chatIdOf.get(cc.key), thread: threadIds.get(cc.thread) || null, bundle: cc.bundle, kind: cc.kind,
  steps: cc.steps.map((s) => ({ task: s.task, who: s.who, at: iso(s.at), ...(s.assist ? { assist: s.assist } : {}) })),
  rows: cc.rows.map((r, i) => ({ seq: i + 1, task: r.task, act: r.act })),
}))
const agentById = new Map(Object.values(AGENTS).map((a) => [a.id, a]))
const chatRows = chatCases.flatMap((cc) => cc.rows.map((r, i) => ({
  case_id: chatIdOf.get(cc.key), seq: i + 1, source: r.agent ? 'agent_delegation' : 'chat_handover', is_explicit: !r.agent,
  from: r.from, to: r.to, to_is_agent: !!r.agent, ...(r.agent ? { to_name: agentById.get(r.to).name } : {}),
  at: iso(r.at), ...(r.returnedAt ? { returned_at: iso(r.returnedAt) } : {}),
  latency_sec: i ? Math.round((r.at - cc.rows[i - 1].at) / 1000) : null, text: r.text, artifacts: r.artifacts || [],
})))

// everyone in the mailbox
const people = {}
for (const [e, p] of Object.entries(CAST)) people[e] = p
for (const m of outMails) for (const e of [m.from, ...m.to, ...m.cc]) {
  if (people[e]) continue
  const c = CUSTOMER_BY_EMAIL.get(e)
  people[e] = c ? { name: c.contact, role: `고객 · ${c.name}` } : PEOPLE_EXTRA[e] || { name: e, role: '' }
}

const out = {
  owner: OWNER, today: '2026-11-12', from: ymd(FROM), to: ymd(TO), people, mails: outMails,
  truth: { model: {
    A: { name: '설계 제안 · 견적', steps: ['요청 메일 접수', '현장 실측', '평면도 작성', '제안서 작성', '견적서 작성', '재무 검토', '고객 회신'], condition: { '재무 검토': 'quote total ≥ 10,000,000원 (부가세 별도)' }, rare: ['법무 검토'] },
    B: { name: '계약 · 시공 준비', steps: ['계약 확정', '자재 발주', '시공 일정 조율', '착공 안내'], parallel: [['자재 발주', '시공 일정 조율']] },
    C: { name: '하자 · AS', steps: ['하자 접수', '현장 방문', '처리 보고'] },
  }, agents: Object.values(AGENTS), cases: truthCases, chat_cases: truthChat, set_times: SET_TIMES },
  chat_handovers: chatRows,
}

// ---------------------------------------------------------------- checks and the summary
const fail = (m) => { console.error('check failed:', m); process.exit(1) }
const bypassAts = []
for (const c of truthCases) for (let i = 1; i < c.steps.length; i++) {
  if (c.steps[i].at < c.steps[i - 1].at) fail(`${c.thread}: steps out of order`)
  if (c.steps[i - 1].task === '요청 메일 접수' && c.steps[i].task === '평면도 작성') bypassAts.push(c.steps[i].at)
}
if (bypassAts.some((a) => a > '2026-09-05T23:59')) fail(`a bypass after 09-05: ${bypassAts}`)
for (const m of outMails) if (![m.from, ...m.to, ...m.cc].includes(OWNER)) fail(`${m.id} is not in the owner's mailbox`)
const realDomain = outMails.flatMap((m) => [m.from, ...m.to, ...m.cc]).filter((e) => !/@(uengine\.org|[a-z0-9.-]+\.example|example\.(com|net|org))$/.test(e))
if (realDomain.length) fail(`addresses outside reserved domains: ${[...new Set(realDomain)]}`)

const json = `${JSON.stringify(out, null, 1)}\n`
if (has('--stdout')) process.stdout.write(json)
else {
  fs.mkdirSync(FIX, { recursive: true })
  fs.writeFileSync(OUT, json)
  if (has('--templates') || !fs.existsSync(path.join(TEMPLATE_DIR, QUOTE_TEMPLATE))) await writeQuoteTemplate(path.join(TEMPLATE_DIR, QUOTE_TEMPLATE))
  for (const [name, title, rows] of FORMS) if (has('--templates') || !fs.existsSync(path.join(TEMPLATE_DIR, name))) await writeFormTemplate(path.join(TEMPLATE_DIR, name), title, rows)
  summary()
}

function summary() {
  const by = (arr, f) => arr.reduce((m, x) => { const k = f(x); m[k] = (m[k] || 0) + 1; return m }, {})
  const trans = {}
  for (const c of truthCases) {
    const seq = ['(시작)', ...c.steps.map((s) => s.task), ...(c.open ? [] : ['(끝)'])]
    for (let i = 1; i < seq.length; i++) { const k = `${c.bundle} ${seq[i - 1]} → ${seq[i]}`; trans[k] = (trans[k] || 0) + 1 }
  }
  const A = truthCases.filter((c) => c.bundle === 'A')
  const fin = A.filter((c) => c.steps.some((s) => s.task === '재무 검토')).length
  const sha = crypto.createHash('sha256').update(json).digest('hex')
  console.log(`wrote ${path.relative(process.cwd(), OUT)}  sha256 ${sha}`)
  console.log(`mails ${outMails.length}  by kind ${JSON.stringify(by(outMails, (m) => m.kind))}  labels ${JSON.stringify(by(outMails, (m) => m.labels[0]))}  threads ${threadIds.size}`)
  console.log(`cases ${truthCases.length}  by bundle ${JSON.stringify(by(truthCases, (c) => c.bundle))}  by variant ${JSON.stringify(by(truthCases, (c) => c.variant))}  open ${truthCases.filter((c) => c.open).length}`)
  console.log(`재무 검토 in ${fin}/${A.length} A cases (${Math.round(100 * fin / A.length)}%)  법무 검토 ${A.filter((c) => c.steps.some((s) => s.task === '법무 검토')).length}  forwards that break the thread ${truthCases.filter((c) => c.extra_threads).length}`)
  console.log(`bypass (요청 → 평면도) ${bypassAts.length}: ${bypassAts.map((a) => a.slice(0, 10)).join(', ')}`)
  console.log(`steps only in chat ${truthCases.flatMap((c) => c.steps).filter((s) => s.via === 'chat').length}  chat cases ${truthChat.length} ${JSON.stringify(by(truthChat, (c) => c.kind))}  chat rows ${chatRows.length} ${JSON.stringify(by(chatRows, (r) => r.source))}`)
  console.log('transitions (truth.cases):')
  for (const [k, n] of Object.entries(trans).sort((a, b) => a[0].localeCompare(b[0], 'ko'))) console.log(`  ${String(n).padStart(3)}  ${k}`)
}

// ---------------------------------------------------------------- the report forms of the work at set times (exceljs)
async function writeFormTemplate(file, title, rows) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Process GPT Lite'
  wb.created = wb.modified = new Date('2026-11-12T00:00:00Z')
  const ws = wb.addWorksheet(title.replace(/\s/g, ''), { views: [{ showGridLines: false }] })
  ws.columns = [{ width: 16 }, { width: 26 }, { width: 16 }, { width: 26 }]
  const font = { name: '맑은 고딕', size: 10 }
  const thin = { style: 'thin', color: { argb: 'FF9CA3AF' } }
  const box = { top: thin, left: thin, bottom: thin, right: thin }
  const gray = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F5' } }
  ws.mergeCells('A1:D1')
  Object.assign(ws.getCell('A1'), { value: title, font: { ...font, size: 18, bold: true }, alignment: { horizontal: 'center', vertical: 'middle' } })
  ws.getRow(1).height = 36
  rows.forEach((labels, i) => {
    const r = i + 3
    if (labels.length === 2) labels.forEach((l, j) => {
      Object.assign(ws.getCell(r, j * 2 + 1), { value: l, font: { ...font, bold: true }, fill: gray, border: box })
      Object.assign(ws.getCell(r, j * 2 + 2), { font, border: box })
    })
    else {
      Object.assign(ws.getCell(r, 1), { value: labels[0], font: { ...font, bold: true }, fill: gray, border: box })
      ws.mergeCells(r, 2, r, 4)
      Object.assign(ws.getCell(r, 2), { font, border: box, alignment: { wrapText: true, vertical: 'top' } })
      ws.getRow(r).height = 48
    }
  })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await wb.xlsx.writeFile(file)
  console.log(`wrote ${path.relative(process.cwd(), file)}`)
}

// ---------------------------------------------------------------- the quote template (exceljs)
async function writeQuoteTemplate(file) {
  const ExcelJS = (await import('exceljs')).default
  const wb = new ExcelJS.Workbook()
  wb.creator = 'Process GPT Lite'
  wb.created = wb.modified = new Date('2026-11-12T00:00:00Z')
  const ws = wb.addWorksheet('견적서', { pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.5, right: 0.5, top: 0.6, bottom: 0.6, header: 0.3, footer: 0.3 } }, views: [{ showGridLines: false }] })
  ws.columns = [{ width: 24 }, { width: 20 }, { width: 9 }, { width: 14 }, { width: 16 }, { width: 18 }]
  const font = { name: '맑은 고딕', size: 10 }
  const thin = { style: 'thin', color: { argb: 'FF9CA3AF' } }
  const box = { top: thin, left: thin, bottom: thin, right: thin }
  const gray = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F5' } }
  const money = '#,##0'
  ws.mergeCells('A1:F1')
  ws.getCell('A1').value = '견 적 서'
  ws.getCell('A1').font = { ...font, size: 20, bold: true }
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' }
  ws.getRow(1).height = 40
  const field = (r, label, cellRange, value, name) => {
    const [a, b] = cellRange.split(':')
    ws.getCell(`${String.fromCharCode(a.charCodeAt(0) - 1)}${r}`).value = label
    ws.getCell(`${String.fromCharCode(a.charCodeAt(0) - 1)}${r}`).font = { ...font, bold: true }
    ws.getCell(`${String.fromCharCode(a.charCodeAt(0) - 1)}${r}`).fill = gray
    ws.getCell(`${String.fromCharCode(a.charCodeAt(0) - 1)}${r}`).border = box
    if (b) ws.mergeCells(`${a}${r}:${b}${r}`)
    const c = ws.getCell(`${a}${r}`)
    c.value = value
    c.font = font
    c.border = box
    if (name) c.name = name
  }
  field(3, '고객명', 'B:C', null, 'customer'); field(3, '견적일', 'E:F', null, 'quote_date')
  field(4, '프로젝트', 'B:C', null, 'project'); field(4, '유효기간', 'E:F', '견적일로부터 30일', 'validity')
  field(5, '현장 주소', 'B:C', null, 'site'); field(5, '담당', 'E:F', null, 'owner')
  ws.getCell('E3').numFmt = 'yyyy-mm-dd'
  ws.mergeCells('A7:F7')
  ws.getCell('A7').value = '아래와 같이 견적합니다. (단위: 원, 부가세 별도)'
  ws.getCell('A7').font = font
  const head = ['품목', '규격', '수량', '단가', '금액', '비고']
  const HEAD = 8, FIRST = 9, LAST = 23
  head.forEach((h, i) => {
    const c = ws.getRow(HEAD).getCell(i + 1)
    c.value = h; c.font = { ...font, bold: true }; c.fill = gray; c.border = box
    c.alignment = { horizontal: 'center', vertical: 'middle' }
  })
  ws.getRow(HEAD).height = 22
  for (let r = FIRST; r <= LAST; r++) {
    for (let col = 1; col <= 6; col++) { const c = ws.getRow(r).getCell(col); c.border = box; c.font = font }
    ws.getCell(`C${r}`).numFmt = money; ws.getCell(`D${r}`).numFmt = money; ws.getCell(`E${r}`).numFmt = money
    ws.getCell(`E${r}`).value = { formula: `IF(AND(ISNUMBER(C${r}),ISNUMBER(D${r})),C${r}*D${r},"")` }
  }
  const totals = [['공급가액', `SUM(E${FIRST}:E${LAST})`, 'supply_total'], ['부가세(10%)', `ROUND(E${LAST + 1}*0.1,0)`, 'vat'], ['합계', `E${LAST + 1}+E${LAST + 2}`, 'grand_total']]
  totals.forEach(([label, formula, name], i) => {
    const r = LAST + 1 + i
    ws.mergeCells(`A${r}:D${r}`)
    const l = ws.getCell(`A${r}`)
    l.value = label; l.font = { ...font, bold: true }; l.fill = gray; l.alignment = { horizontal: 'center' }
    for (const col of ['A', 'B', 'C', 'D', 'E', 'F']) ws.getCell(`${col}${r}`).border = box
    const v = ws.getCell(`E${r}`)
    v.value = { formula }; v.numFmt = money; v.font = { ...font, bold: i === 2 }; v.name = name
  })
  ws.mergeCells(`A${LAST + 5}:F${LAST + 5}`)
  ws.getCell(`A${LAST + 5}`).value = '※ 본 견적의 유효기간은 견적일로부터 30일입니다. 위 단가와 공급가액은 부가세 별도이며, 부가세(10%)는 따로 표기했습니다.'
  ws.getCell(`A${LAST + 5}`).font = { ...font, size: 9 }
  ws.mergeCells(`A${LAST + 6}:F${LAST + 6}`)
  ws.getCell(`A${LAST + 6}`).value = '※ 현장 여건(철거 범위, 설비 이동)에 따라 금액이 달라질 수 있습니다.'
  ws.getCell(`A${LAST + 6}`).font = { ...font, size: 9 }
  wb.definedNames.add(`견적서!$A$${FIRST}:$F$${LAST}`, 'items')
  ws.pageSetup.printArea = `A1:F${LAST + 6}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await wb.xlsx.writeFile(file)
  console.log(`wrote ${path.relative(process.cwd(), file)}`)
}
