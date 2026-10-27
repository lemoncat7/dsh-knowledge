import { buildSearchQuery } from './search-query.js'

export interface KnowledgePassage {
  text: string
  heading: string
  /** Unicode code-point offsets, identical to knowledge_read pagination. */
  offset: number
  endOffset: number
  totalChars: number
  startLine: number
  endLine: number
  truncated: boolean
  matched: boolean
}

interface Block { start: number; end: number; heading: string }

/** Ephemeral passage selection. The authoritative document is never split or rewritten. */
export function selectKnowledgePassage(body: string, query: string, maxChars = 420): KnowledgePassage {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.min(2000, Math.trunc(maxChars))) : 420
  const terms = buildSearchQuery(query).toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean)
  const exact = query.trim().toLocaleLowerCase('zh-CN')
  const score = (text: string) => {
    const lower = text.toLocaleLowerCase('zh-CN')
    return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0)
      + (exact.length >= 2 && lower.includes(exact) ? Math.max(2, terms.length) : 0)
  }
  const blocks = markdownBlocks(body)
  let best = blocks[0] ?? { start: 0, end: body.length, heading: '' }
  let bestScore = -1
  for (const block of blocks) {
    const value = score(body.slice(block.start, block.end)) + score(block.heading) * .15
    if (value > bestScore) { best = block; bestScore = value }
  }
  const chars = Array.from(body.slice(best.start, best.end))
  let start = 0
  if (chars.length > budget) {
    // Evaluate overlapping windows instead of always clipping the section's start.
    let windowScore = -1
    const stride = Math.max(1, Math.floor(budget / 2))
    for (let i = 0; ; i = Math.min(chars.length - budget, i + stride)) {
      const value = score(chars.slice(i, i + budget).join(''))
      if (value > windowScore) { start = i; windowScore = value }
      if (i === chars.length - budget) break
    }
  }
  const text = chars.slice(start, start + budget).join('')
  const prefix = body.slice(0, best.start) + chars.slice(0, start).join('')
  const offset = Array.from(prefix).length
  const totalChars = Array.from(body).length
  const endOffset = offset + Array.from(text).length
  const startLine = 1 + (prefix.match(/\n/g)?.length ?? 0)
  return {
    text, heading: best.heading, offset, endOffset, totalChars, startLine,
    endLine: startLine + (text.match(/\n/g)?.length ?? 0),
    truncated: offset > 0 || endOffset < totalChars,
    matched: score(text) > 0,
  }
}

/** Fence-aware paragraphs and ATX heading paths; no Markdown rendering or mutation. */
function markdownBlocks(body: string): Block[] {
  const blocks: Block[] = []
  const headings: { level: number; text: string }[] = []
  let start = 0, position = 0, heading = ''
  let hasContent = false
  let fence: { char: string; length: number } | undefined
  const flush = (end: number) => {
    if (body.slice(start, end).trim()) blocks.push({ start, end, heading })
    start = end
    hasContent = false
  }
  for (const line of body.split(/(?<=\n)/u)) {
    const end = position + line.length
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*?)(?:\r?\n)?$/u)
    if (fence) {
      if (delimiter && delimiter[1]![0] === fence.char && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = undefined
    } else if (delimiter) {
      fence = { char: delimiter[1]![0]!, length: delimiter[1]!.length }
      hasContent = true
    } else {
      const title = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/u)
      if (title) {
        // Consecutive parent/child headings are context, not standalone evidence.
        // Carry them into the first substantive block instead of selecting a title only.
        if (hasContent) flush(position)
        const level = title[1]!.length
        while (headings.length && headings.at(-1)!.level >= level) headings.pop()
        headings.push({ level, text: title[2]!.trim() })
        heading = headings.map(item => item.text).join(' / ')
      } else if (!line.trim()) {
        // A matching heading alone is not evidence. Keep it with its first paragraph.
        if (hasContent) flush(end)
      } else {
        hasContent = true
      }
    }
    position = end
  }
  flush(body.length)
  return blocks
}
