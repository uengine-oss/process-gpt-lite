// items through fn, at most n at a time, the results in the items' order (a slow one does not hold the others back, and a long
// list does not open a connection per item). fn should catch its own errors: if it throws, pool rejects at once while the other
// workers go on through the rest in the background (their later errors are dropped) — the caller learns of the first one only.
export async function pool(items, n, fn) {
  const list = [...(items || [])]
  const out = new Array(list.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, list.length)) }, async () => {
    while (next < list.length) { const i = next++; out[i] = await fn(list[i], i) }
  }))
  return out
}
