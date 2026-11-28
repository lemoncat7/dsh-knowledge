/**
 * Request id for one reminder acknowledgement.
 *
 * Kept separate from the component so the fallback path is testable without a DOM:
 * the acknowledgement lock is released in `finally`, but the id used to be minted
 * before the `try`, so a throwing `crypto.randomUUID()` (non-secure context, older
 * browser) skipped the `finally` and left every "知道了" button disabled forever.
 *
 * The fallback only needs to be unique per calendar/reminder/remindAt signature for
 * the lifetime of one popover, so a counter plus a little entropy is enough.
 */
let counter = 0

export function nextAckRequestId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.()
    if (typeof uuid === 'string' && uuid.length > 0) return uuid
  } catch {
    // Insecure contexts and older browsers may not provide randomUUID at all.
  }
  counter = (counter + 1) % 0xffff
  const entropy = Math.random().toString(36).slice(2, 8)
  return `${Date.now().toString(36)}-${counter.toString(36)}-${entropy}`
}
