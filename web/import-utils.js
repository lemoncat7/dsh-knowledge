/**
 * Pure helpers for Markdown file import. Loaded by web/app.js as an ES module
 * and imported directly by node tests, so it must stay dependency-free and
 * DOM-free.
 */

export const IMPORT_MAX_BODY_CHARS = 50_000
export const IMPORT_ACCEPT = '.md,.markdown'

const TITLE_MAX_CHARS = 200

/**
 * Derives a document title: the first Markdown heading if present, otherwise
 * the file name without its .md/.markdown extension.
 */
export function titleFromMarkdown(fileName, text) {
  const source = typeof text === 'string' ? text : ''
  if (source.length > 0) {
    for (const line of source.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const heading = /^#{1,6}\s+(.+?)\s*#*$/u.exec(trimmed)
      if (heading && heading[1].trim()) return heading[1].trim().slice(0, TITLE_MAX_CHARS)
      break
    }
  }
  const base = String(fileName ?? '').replace(/\.(markdown|md)$/i, '').trim()
  return base.slice(0, TITLE_MAX_CHARS) || '导入文档'
}

/**
 * Splits Markdown into chunks that each fit the knowledge body limit,
 * preferring H2 section boundaries. Returns at least one chunk for non-empty
 * input; each chunk is non-empty and at most maxChars long.
 */
export function splitMarkdownByH2(text, maxChars = IMPORT_MAX_BODY_CHARS) {
  const source = String(text ?? '').trim()
  if (!source) return []
  if (source.length <= maxChars) return [source]
  const lines = source.split(/\r?\n/)
  const boundaries = []
  let offset = 0
  for (const line of lines) {
    if (/^##\s+\S/u.test(line)) boundaries.push(offset)
    offset += line.length + 1
  }
  const parts = []
  if (boundaries.length === 0) {
    parts.push(source)
  } else {
    if (boundaries[0] > 0) parts.push(source.slice(0, boundaries[0]).trim())
    for (let index = 0; index < boundaries.length; index += 1) {
      const start = boundaries[index]
      const end = index + 1 < boundaries.length ? boundaries[index + 1] : source.length
      const section = source.slice(start, end).trim()
      if (section) parts.push(section)
    }
  }
  const chunks = []
  let buffer = ''
  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) chunks.push(trimmed)
    buffer = ''
  }
  for (const part of parts) {
    if (part.length > maxChars) {
      flush()
      chunks.push(...hardSplit(part, maxChars))
      continue
    }
    if (!buffer) buffer = part
    else if (buffer.length + part.length + 2 <= maxChars) buffer = `${buffer}\n\n${part}`
    else {
      flush()
      buffer = part
    }
  }
  flush()
  return chunks
}

function hardSplit(text, maxChars) {
  const chunks = []
  let buffer = ''
  const flush = () => {
    const trimmed = buffer.trim()
    if (trimmed) chunks.push(trimmed)
    buffer = ''
  }
  for (const paragraph of text.split(/\n{2,}/)) {
    if (paragraph.length > maxChars) {
      flush()
      for (let index = 0; index < paragraph.length; index += maxChars) {
        const piece = paragraph.slice(index, index + maxChars).trim()
        if (piece) chunks.push(piece)
      }
      continue
    }
    if (!buffer) buffer = paragraph
    else if (buffer.length + paragraph.length + 2 <= maxChars) buffer = `${buffer}\n\n${paragraph}`
    else {
      flush()
      buffer = paragraph
    }
  }
  flush()
  return chunks
}
