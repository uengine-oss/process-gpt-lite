// The address prefix the app is served under: '' at a domain root, '/lite' behind the ProcessGPT
// gateway (<tenant>.process-gpt.io/lite, built with VITE_BASE_PATH=/lite/). The gateway strips the
// prefix before it reaches nginx, but the browser still resolves every root path against the page.
export const BASE = import.meta.env.BASE_URL.replace(/\/$/, '')
