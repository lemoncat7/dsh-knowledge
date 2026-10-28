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

export interface PassageBlock { start: number; end: number; offset: number; startLine: number; heading: string; sectionId: number | null }
export interface PassageSection { id: number; parentId: number | null; level: number; heading: string }
export interface PassageStructure { blocks: PassageBlock[]; sections: PassageSection[]; totalChars: number }

/** Ephemeral passage selection. The authoritative document is never split or rewritten. */
export function selectKnowledgePassage(body: string, query: string, maxChars = 420, structure?: PassageStructure): KnowledgePassage {
  const budget = Number.isFinite(maxChars) ? Math.max(1, Math.min(2000, Math.trunc(maxChars))) : 420
  const terms = buildSearchQuery(query).toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean)
  const exact = query.trim().toLocaleLowerCase('zh-CN')
  const score = (text: string) => {
    const lower = text.toLocaleLowerCase('zh-CN')
    return terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0)
      + (exact.length >= 2 && lower.includes(exact) ? Math.max(2, terms.length) : 0)
  }
  const prepared = structure ?? buildPassageStructure(body)
  const blocks = prepared.blocks
  let best = blocks[0] ?? { start: 0, end: body.length, offset: 0, startLine: 1, heading: '', sectionId: null }
  let bestScore = -1
  const headingScores = new Map<string, number>()
  for (const block of blocks) {
    let headingScore = headingScores.get(block.heading)
    if (headingScore === undefined) { headingScore = score(block.heading); headingScores.set(block.heading, headingScore) }
    const value = score(body.slice(block.start, block.end)) + headingScore * .15
    if (value > bestScore) { best = block; bestScore = value }
  }
  // One contiguous excerpt: adjacent paragraphs from the same section only,
  // never duplicate overlapping text or silently merge unrelated headings.
  const selected = blocks.indexOf(best)
  if (selected >= 0 && Array.from(body.slice(best.start, best.end)).length < budget) {
    let from = selected, to = selected
    for (const direction of [1, -1]) {
      while (true) {
        const candidate = blocks[direction === 1 ? to + 1 : from - 1]
        if (!candidate || candidate.sectionId !== best.sectionId) break
        const start = direction === 1 ? best.start : candidate.start
        const end = direction === 1 ? candidate.end : best.end
        if (Array.from(body.slice(start, end)).length > budget) break
        best = { ...best, start, end, ...(direction === -1 ? { offset: candidate.offset, startLine: candidate.startLine } : {}) }
        if (direction === 1) to++; else from--
      }
    }
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
  const prefix = chars.slice(0, start).join('')
  const offset = best.offset + start
  const totalChars = prepared.totalChars
  const endOffset = offset + Array.from(text).length
  const startLine = best.startLine + (prefix.match(/\n/g)?.length ?? 0)
  return {
    text, heading: best.heading, offset, endOffset, totalChars, startLine,
    endLine: startLine + (text.match(/\n/g)?.length ?? 0),
    truncated: offset > 0 || endOffset < totalChars,
    matched: score(text) > 0,
  }
}

/** Fence-aware paragraphs and ATX heading paths; no Markdown rendering or mutation. */
export function buildPassageStructure(body: string): PassageStructure {
  const blocks: PassageBlock[] = []
  const sections: PassageSection[] = []
  const headings: { level: number; text: string; id: number }[] = []
  let start = 0, position = 0, heading = ''
  let offset = 0, startLine = 1
  let hasContent = false
  let fence: { char: string; length: number } | undefined
  const flush = (end: number) => {
    const segment = body.slice(start, end)
    if (segment.trim()) blocks.push({ start, end, offset, startLine, heading, sectionId: headings.at(-1)?.id ?? null })
    offset += Array.from(segment).length
    startLine += segment.match(/\n/g)?.length ?? 0
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
        const id = sections.length
        const parentId = headings.at(-1)?.id ?? null
        headings.push({ level, text: title[2]!.trim(), id })
        heading = headings.map(item => item.text).join(' / ')
        sections.push({ id, parentId, level, heading })
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
  return { blocks, sections, totalChars: offset }
}
