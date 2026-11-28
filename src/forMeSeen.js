// 대화 › 나에게 온 것: when an item counts as seen, and how far its room is read then (components/team/Messenger.vue). Pure — unit tested
// in server/test/forMeSeen.test.js.
//   seenEnough(entry): an IntersectionObserver entry on screen enough — most of the item, or (an item taller than the list) most of the
//     list's height (PR #127 review: an item taller than ~1.7 lists never reached 60 % of itself)
//   readPoint(items, room, seen): the newest unread item of the room up to which every unread one, oldest first, has been seen — null when
//     its oldest unread item has not been (an older item below the fold, never on screen, keeps its unread and its Home card)
export const SEEN_SHARE = 0.6

export function seenEnough(e, share = SEEN_SHARE) {
  if (!e?.isIntersecting) return false
  if (e.intersectionRatio >= share) return true
  return !!e.rootBounds && e.rootBounds.height > 0 && e.intersectionRect.height >= share * e.rootBounds.height
}

export function readPoint(items, room, seen) {
  let point = null
  const mine = (items || []).filter((x) => x.threadId === room && x.unread).sort((p, q) => new Date(p.at) - new Date(q.at))
  for (const x of mine) {
    if (!seen.has(x.id)) break
    point = x
  }
  return point
}
