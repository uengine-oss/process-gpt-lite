// What a Home card shows of a notice: the words, not the machine part an agent's answer sometimes
// carries. process-gpt's chat notification copies the whole answer into the title — "휴가 신청이 …
// 말씀해 주세요! 😊 ```json { "action": "process_executed", … "instance_id": "leave_request_…-d8285a0f13d3" } ```"
// (2026-11-21 phone review): the JSON made the card wider than the phone and hid its ✕ off screen.
export function noticeText(value, max = 160) {
  let t = String(value ?? '')
  // fenced blocks, closed or cut off by a length limit
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/, ' ')
  // a bare JSON object or array at the end ("… 완료됐어요. {"status": "success", …}")
  const tail = /[{[]\s*"[\w$-]+"\s*:/.exec(t)
  if (tail && /[}\]]\s*$/.test(t)) t = t.slice(0, tail.index)
  // markdown marks read as noise on a card
  t = t.replace(/\*\*|__|`/g, '').replace(/^\s*#{1,6}\s+/gm, '').replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, '$1')
  t = t.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}
