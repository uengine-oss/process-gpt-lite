// 대화를 프로젝트로 옮기기 — the words of the move (spec thread-to-project, components/ConversationMoveSheet.vue · ProjectOfferCard.vue · Message.vue,
// server lib/conversationMove.js). No browser state here: tested in server/test/convMove.test.js.
import { ro, josa } from './josa.js'

const n = (x) => Math.max(0, Number(x) || 0)
// what the move does, said before it (2026-11-28 사용자: 「이관 후엔 이 채팅 내용은 프로젝트에서만 볼 수 있음. 기존 채팅 목록에서는 제거됩니다... 라는 알림도 줘야」)
export function moveNotice({ count, project }) {
  return `옮기면 이 대화(메시지 ${n(count)}개)는 프로젝트 「${project}」에서만 볼 수 있어요. 채팅 목록과 전체 대화에서는 사라져요.`
}
// the same for a project not made yet (「새 프로젝트로」's card)
export function moveNewNotice({ count }) {
  return `만들면 이 대화(메시지 ${n(count)}개)를 새 프로젝트로 옮겨요. 옮긴 대화는 그 프로젝트에서만 볼 수 있고, 채팅 목록과 전체 대화에서는 사라져요.`
}
// who else sees what the conversation makes once it is in the project (its shared folder's other members — names, three at most)
export function membersLine({ folder, members = [] }) {
  const names = members.map((m) => m.name).filter(Boolean)
  const shown = names.slice(0, 3).join(' · ') + (names.length > 3 ? ` 외 ${names.length - 3}명` : '')
  const where = folder ? `이 프로젝트는 공유 폴더 「${folder}」${josa(`「${folder}」`, '을', '를')} 사용해요. ` : ''
  return `${where}옮긴 뒤 이 대화에서 만드는 파일은 프로젝트 구성원 ${members.length}명${shown ? `(${shown})` : ''}도 볼 수 있어요.`
}
// done: the line over the composer in the project
export const movedNotice = (project) => `프로젝트 「${project}」${ro(`「${project}」`)} 옮겼어요 · 채팅 목록에서는 빠졌어요`
// a link to a conversation that has since moved (/chat/c/<id>): where it went
export const followedNotice = (project) => `이 대화는 프로젝트 「${project}」${ro(`「${project}」`)} 옮겼어요`
export const backNotice = () => '채팅으로 되돌렸어요 · 채팅 목록에 다시 있어요'
// a project's line under its name in the list: the folder it works in (and whose it is)
export function projectLine(p) {
  if (!p?.folder) return ''
  if (p.folder.workspace) return `템플릿 「${p.folder.name}」의 전용 작업 공간`
  return `공유 폴더 「${p.folder.name}」`
}
