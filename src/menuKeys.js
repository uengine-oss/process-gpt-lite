// ↑ ↓ (Home · End) between the items of a menu (role="menu" · role="menuitem" — the answer's and a file card's menus: AnswerShareSheet.vue ·
// FileCardMenu.vue), as a menu is walked with the keyboard; Tab still goes through them in order
export function menuKeys(e) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
  const menu = e.target.closest?.('[role="menu"]')
  if (!menu) return
  const items = [...menu.querySelectorAll('[role="menuitem"]:not([disabled])')]
  if (!items.length) return
  e.preventDefault()
  const i = items.indexOf(e.target.closest('[role="menuitem"]'))
  const n = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i - 1 + items.length) % items.length
  items[n].focus()
}
