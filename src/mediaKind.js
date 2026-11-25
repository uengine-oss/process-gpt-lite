// What a browser shows or plays by itself: a picture, a sound, a video. Such a file in a conversation is looked at or played right
// there (MediaPreview.vue, MediaViewer.vue); its ArtCraft editor opens only when the person asks to edit it (src/openPlan.js).
// 2026-11-25 「대화창안에서 기본적인 음성 / 이미지가 미리보기 등의 출력이 안되다니.. 포토크래프트등의 편집기는 편집의 의도가 있을따만 시도하는 것이고.」
// A TIFF (a fax above all) is a picture too: the browser does not draw it, the app does (src/tiff.js, components/TiffView.vue) — so every
// place that shows pictures shows it the same way (2026-11-25 「tif 파일을 웹에서 못 열어보나?」).
// Kept without a browser so it is tested without one (server/test/openPlan.test.js, server/test/tiff.test.js).
import { extOf } from './editorKinds.js'

const TIFF_EXT = new Set(['tif', 'tiff'])
const TIFF_TYPES = new Set(['image/tiff', 'image/tiff-fx', 'image/x-tiff'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico', 'apng', ...TIFF_EXT])
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'weba'])
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
// the picture types every browser draws, and TIFF, which the app draws (not HEIC · PSD, which are image/* too)
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/pjpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'image/avif', 'image/bmp',
  'image/x-icon', 'image/vnd.microsoft.icon', 'image/apng', ...TIFF_TYPES])
// a type that says nothing about the content: the name decides
const GENERIC = new Set(['', 'application/octet-stream', 'binary/octet-stream', 'application/unknown'])

/** 'image' | 'audio' | 'video' | '' for a file {name, url, type}: by its stored type (MIME) when it has one, else by its extension */
export function mediaKindOf(f) {
  const t = String(f?.type || '').toLowerCase().split(';')[0].trim()
  if (!GENERIC.has(t)) {
    if (IMAGE_TYPES.has(t)) return 'image'
    if (t.startsWith('audio/')) return 'audio'
    if (t.startsWith('video/')) return 'video'
    return ''
  }
  // (a name without an extension — a site's 「download」 — leaves it to the address's)
  const e = extOf(f?.name) || extOf(f?.url)
  return IMAGE_EXT.has(e) ? 'image' : AUDIO_EXT.has(e) ? 'audio' : VIDEO_EXT.has(e) ? 'video' : ''
}

/** a TIFF picture (the app decodes it itself — src/tiff.js): by its stored type when it has a telling one, else by its name or address */
export function isTiff(f) {
  const t = String(f?.type || '').toLowerCase().split(';')[0].trim()
  if (!GENERIC.has(t)) return TIFF_TYPES.has(t)
  return TIFF_EXT.has(extOf(f?.name) || extOf(f?.url))
}
