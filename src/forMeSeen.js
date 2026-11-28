// 대화 › 나에게 온 것: when an item counts as seen, and how far its room is read then (components/team/Messenger.vue). Pure — unit tested
// in server/test/forMeSeen.test.js.
//   seenEnough(entry): an IntersectionObserver entry on screen enough — most of the item, or (an item taller than the list) most of the
//     list's height (PR #127 review: an item taller than ~1.7 lists never reached 60 % of itself)
//   thresholdFor(h, R): the one threshold an item of height h in a list of height R is observed with — its own 60 %, or for a tall item
//     the share of itself that fills 60 % of the list (fixed steps missed items many lists tall — PR #127 review 2)
//   readRun(items, room, seen): {from, to} — the oldest unread item of the room and the newest one up to which every unread one, oldest
//     first, has been seen; null when its oldest unread item has not been (an older item below the fold keeps its unread and its Home card).
//     The server is sent both: it does not move past an unread item before `from` (one this list never showed)
export const SEEN_SHARE = 0.6

// (a pixel of slack: the observer reports the crossing itself, rounded)
export function seenEnough(e, share = SEEN_SHARE) {
  if (!e?.isIntersecting) return false
  if (e.intersectionRatio >= share - 0.005) return true
  return !!e.rootBounds && e.rootBounds.height > 0 && e.intersectionRect.height >= share * e.rootBounds.height - 1
}

export function thresholdFor(h, R, share = SEEN_SHARE) {
  if (!(h > 0) || !(R > 0)) return share
  return Math.max(0.001, Math.min(share, (share * R) / h))
}

export function readRun(items, room, seen) {
  const mine = (items || []).filter((x) => x.threadId === room && x.unread).sort((p, q) => new Date(p.at) - new Date(q.at))
  let to = null
  for (const x of mine) {
    if (!seen.has(x.id)) break
    to = x
  }
  return to ? { from: mine[0], to } : null
}
