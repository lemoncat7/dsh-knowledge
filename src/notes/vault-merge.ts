/** Bounded, conservative line merge. Multiple/overlapping edit regions remain conflicts. */
export function mergeVaultText(base: Uint8Array, local: Uint8Array, external: Uint8Array): Buffer | null {
  if ([base, local, external].some(b => b.length > 1024 * 1024)) return null
  let texts: string[]
  try { texts = [base, local, external].map(b => new TextDecoder('utf-8', { fatal: true }).decode(b)) } catch { return null }
  if (texts.some(s => s.includes('\0'))) return null
  const [b, l, e] = texts as [string, string, string]
  if (l === e) return Buffer.from(l)
  if (b === l) return Buffer.from(e)
  if (b === e) return Buffer.from(l)
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const original = lines(b)
  const change = (text: string) => {
    const next = lines(text)
    let start = 0, end = original.length, stop = next.length
    while (start < end && start < stop && original[start] === next[start]) start++
    while (end > start && stop > start && original[end - 1] === next[stop - 1]) { end--; stop-- }
    return { start, end, replacement: next.slice(start, stop) }
  }
  const edits = [change(l), change(e)].sort((a, b) => a.start - b.start)
  // Adjacent boundary insertions can carry ordering intent; leave them to the user.
  if (edits[0]!.end >= edits[1]!.start) return null
  for (const edit of edits.reverse()) original.splice(edit.start, edit.end - edit.start, ...edit.replacement)
  return Buffer.from(original.join(''))
}
