// A phone's back gesture already animates: Chrome slides the page away and shows a picture of the
// previous one. Our own fade (blur in, .4s) on top of that read as a blink — sharp picture, blurred
// page, sharp page (2026-11-21 phone review: "꿈뻑 하면서"). When the browser says it animated this
// history step (PopStateEvent.hasUAVisualTransition, Chrome 123+), the page skips its transitions for
// that step (styles/base.css .ua-nav).
export function watchUaTransitions(target = window) {
  let timer
  const root = () => target.document?.documentElement
  target.addEventListener('popstate', (e) => {
    if (!e.hasUAVisualTransition) return
    root()?.classList.add('ua-nav')
    clearTimeout(timer)
    timer = setTimeout(() => root()?.classList.remove('ua-nav'), 700)
  })
}
