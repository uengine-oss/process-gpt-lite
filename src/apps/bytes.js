// Bytes across the MCP Apps bridge (JSON): base64, and a message with bytes in it — the same shape as the screens'
// runtime (server/lib/apps/runtime/lite.js pack/unpack): {__b64, __as: 'buffer' | 'bytes'}. No imports: tests read it too.
export function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000))
  return btoa(s)
}
export const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
export const pack = (v) => (v instanceof ArrayBuffer ? { __b64: b64(v), __as: 'buffer' } : ArrayBuffer.isView(v) ? { __b64: b64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), __as: 'bytes' }
  : Array.isArray(v) ? v.map(pack) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, pack(x)])) : v)
export const unpack = (v) => (v && typeof v === 'object' && typeof v.__b64 === 'string' ? (v.__as === 'buffer' ? unb64(v.__b64).buffer : unb64(v.__b64))
  : Array.isArray(v) ? v.map(unpack) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, unpack(x)])) : v)
