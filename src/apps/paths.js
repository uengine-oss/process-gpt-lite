// The Lite screens an app's ui/open-link may move the person to (src/apps/AppFrame.vue); no imports, so tests read it too.
const NAV = /^\/(workroom\/aidlc\/[A-Za-z0-9._-]+|aidlc\/[A-Za-z0-9._-]+\/decide|apps\/[a-z][a-z0-9-]{1,30}\/[A-Za-z0-9._-]+|folders\/[A-Za-z0-9._-]+)(\?[^#\s]*)?$/
export const navAllowed = (url) => NAV.test(String(url || ''))
