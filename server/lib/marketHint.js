// Stock and index prices: where the agent reads them and how it finds the right listing. Without
// this the agent guessed — "AST 모바일" became a made-up domestic code (096540) and the run said it
// could not find it, while the person meant AST SpaceMobile on NASDAQ (2026-11-21 phone review).
// Naver's public JSON needs no key (a browser User-Agent header only); every answer names its source.
import { L } from './lang.js'

export const MARKET_WORDS = /주가|주식|종목|시세|코스피|코스닥|나스닥|다우|s&p|증시|급등|급락|등락|상승률|하락률|티커|\bstocks?\b|\bshares?\b|\bticker\b|\bkospi\b|\bkosdaq\b|\bnasdaq\b|\bnyse\b|stock price/i

const KO = `

(주가·지수는 네이버 증권의 공개 JSON 을 샌드박스에서 직접 읽으세요. 키는 필요 없고 요청 헤더에 User-Agent: Mozilla/5.0 만 넣으면 돼요.
① 이름 → 종목: https://ac.stock.naver.com/ac?q=<이름>&target=stock,index — items 의 code(국내 6자리) · reutersCode(해외, 예 TSLA.O) · typeCode(KOSPI·KOSDAQ·NASDAQ·NYSE…) · nationCode.
   이름이 그대로 안 나오면 띄어쓰기·영문·약칭·티커로 바꿔 다시 찾으세요(예: "AST 모바일" → "AST" → AST 스페이스모바일, ASTS · NASDAQ). 국내·해외 둘 다 볼 것. 그래도 없으면 코드를 지어내지 말고 후보와 함께 못 찾았다고 쓰세요.
② 일별 종가: 국내 https://api.stock.naver.com/chart/domestic/item/<code>/day?startDateTime=YYYYMMDD0000&endDateTime=YYYYMMDD0000 · 지수 …/chart/domestic/index/KOSPI/day (KOSDAQ 도 같은 꼴) · 해외 https://api.stock.naver.com/chart/foreign/item/<reutersCode>/day?… — 응답은 [{localDate, closePrice, …}] 이고 거래일만 있어요. "5거래일 누적"은 가장 최근 종가와 그 5거래일 전 종가로 계산하세요.
③ 결과에는 고른 종목(이름 · 시장 · 코드)과 기준 날짜를 밝히고, 맨 끝에 "출처: 네이버 증권(…)" 한 줄을 붙이세요.)`

const EN = `

(For stock and index prices, read Naver Finance's public JSON yourself in the sandbox — no key, only a User-Agent: Mozilla/5.0 header.
1) Name → listing: https://ac.stock.naver.com/ac?q=<name>&target=stock,index — items carry code (Korea, 6 digits), reutersCode (abroad, e.g. TSLA.O), typeCode (KOSPI, KOSDAQ, NASDAQ, NYSE…) and nationCode.
   If the name does not match as written, try other spacing, the English name, a short form or the ticker (e.g. "AST mobile" → "AST" → AST SpaceMobile, ASTS on NASDAQ); check both Korean and foreign listings. If it still is not there, never invent a code: say it was not found and list the candidates.
2) Daily closes: Korea https://api.stock.naver.com/chart/domestic/item/<code>/day?startDateTime=YYYYMMDD0000&endDateTime=YYYYMMDD0000, indices …/chart/domestic/index/KOSPI/day (KOSDAQ likewise), abroad https://api.stock.naver.com/chart/foreign/item/<reutersCode>/day?… — the answer is [{localDate, closePrice, …}], trading days only. "Over 5 trading days" means the latest close against the close 5 trading days before it.
3) In the result name the listing you used (name, market, code) and the date, and end with one line "Source: Naver Finance (…)".)`

export function marketHint(text) {
  return MARKET_WORDS.test(String(text || '')) ? L(KO, EN) : ''
}

// The router writes the task's standing instruction, and a small model "helps" by adding a listing code
// it guessed: "AST모바일(031440)" — every run then looked for that code and failed (2026-11-21 rehearsal).
// In a stock request, a code in brackets the person never wrote is taken out; the run looks it up.
export function stripInventedCodes(prompt, said) {
  const p = String(prompt || '')
  if (!MARKET_WORDS.test(`${p} ${said || ''}`)) return p
  const heard = String(said || '').toLowerCase()
  // only what is shaped like a listing code: six digits (국내), or a ticker (TSLA, ASTS.O) — never units or
  // common abbreviations ("(ETF)", "(KST)", "(USD)", "(10)")
  const COMMON = /^(ETF|ETN|KST|UTC|USD|KRW|JPY|EUR|CNY|PER|PBR|ROE|EPS|AI|IPO|CEO|API|GDP|CPI|FOMC|YOY|QOQ|MAX|MIN|AVG)$/
  const listing = (c) => /^\d{6}$/.test(c) || (/^[A-Z]{2,5}(\.[A-Z]{1,2})?$/.test(c) && !COMMON.test(c))
  return p.replace(/\s*[(（]\s*([A-Za-z0-9.:-]{2,12})\s*[)）]/g, (m, code) => (listing(code) && !heard.includes(code.toLowerCase()) ? '' : m))
}
