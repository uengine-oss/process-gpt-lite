// A main chat with two conversations the context router told apart, each with files the agent
// made (pro_messages kind 'file'), as the router and the agent would have left them.
import * as api from './api.js'
import { PNG_1PX, SVG, XLSX, MIME } from './seed.js'

export async function seedConversations(db, u, { tripFiles = 3, ytFiles = 10 } = {}) {
  const th = await db.clearMain(u.id)
  const xlsx = await api.upload(u.token(), '숙소 비교.xlsx', MIME.xlsx, await XLSX([['숙소', '가격'], ['A 호텔', 120000], ['B 호텔', 98000]]))
  const png = await api.upload(u.token(), 'thumb.png', MIME.png, PNG_1PX)
  const svg = await api.upload(u.token(), 'banner.svg', MIME.svg, SVG('회귀 배너'))
  const trip = { conversationId: 'rt-conv-trip', action: 'new', title: '출장 숙소', by: 'judge' }
  const yt = { conversationId: 'rt-conv-yt', action: 'new', title: '유튜브 채널', by: 'judge' }
  const files = (n, prefix) => Array.from({ length: n }, (_, i) => {
    const pick = [{ name: `${prefix} ${i + 1}.xlsx`, url: xlsx.url }, { name: `${prefix} ${i + 1}.png`, url: png.url }, { name: `${prefix} ${i + 1}.svg`, url: svg.url }][i % 3]
    return { role: 'agent', kind: 'file', content: pick }
  })
  const msgs = await db.addMessages(th, [
    { role: 'user', kind: 'text', content: { text: '부산 출장 숙소 알아봐줘' } },
    { role: 'agent', kind: 'text', content: { text: '숙소 후보를 표로 정리했어요.', context: trip } },
    ...files(tripFiles, '숙소'),
    { role: 'user', kind: 'text', content: { text: '우리 유튜브 채널 최근 영상 알려줘' } },
    { role: 'agent', kind: 'text', content: { text: '최근 영상 10개예요.', context: yt } },
    ...files(ytFiles, '영상'),
  ])
  await db.addConversation(u.id, 'rt-conv-trip', '출장 숙소', { summary: '최근 요청: 부산 출장 숙소', gist: '숙소 비교' })
  await db.addConversation(u.id, 'rt-conv-yt', '유튜브 채널', { summary: '최근 요청: 채널 최근 영상', gist: '영상 목록' })
  return { th, msgs, xlsx, png, svg }
}
