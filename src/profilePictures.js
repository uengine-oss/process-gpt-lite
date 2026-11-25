// A person's picture on the screens (the server's rules: server/lib/profilePicture.js). Nothing here touches the page or the
// network, so the server's tests read it too (server/test/profilePicture.test.js).

// Process GPT's preset pictures, the exact root paths its account settings save in users.profile (in its order).
// The same 18 files are in Lite's public/assets/images/profile/ — an install without Process GPT in front still shows them.
export const PRESET_DIR = '/assets/images/profile/'
export const PRESETS = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `${PRESET_DIR}${n}.jpg`),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `${PRESET_DIR}user-${n}.jpg`),
]

// Where to load a picture from, in order. A preset is first asked of the site's root — behind the gateway that is Process GPT's
// own file (<tenant>.process-gpt.io/assets/…, Lite being at /lite) — and then of Lite's own copy under its base path. On its
// own domain (base '') the root is Lite's copy already. Anything else has one address; when none loads, the initial shows.
export function faceSources(picture, base = '') {
  if (!picture || typeof picture !== 'string') return []
  const b = String(base || '').replace(/\/+$/, '')
  if (b && picture.startsWith(PRESET_DIR)) return [picture, b + picture]
  return [picture]
}

// the middle square of a picture (what an avatar circle shows): {sx, sy, s} in the picture's own pixels
export function squareCrop(w, h) {
  const s = Math.max(1, Math.floor(Math.min(w, h)))
  return { sx: Math.floor((w - s) / 2), sy: Math.floor((h - s) / 2), s }
}

// the first letter of a name (the circle without a picture)
export const initialOf = (name) => String(name || '?').trim().slice(0, 1) || '?'
