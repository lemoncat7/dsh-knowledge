import { mergeKnowledgeBodies } from './knowledge-merge.js'

export type DiffLineKind = 'context' | 'add' | 'remove'

export interface DiffLine {
  kind: DiffLineKind
  text: string
  oldLine?: number
  newLine?: number
}

export interface LineDiff {
  lines: DiffLine[]
  additions: number
  deletions: number
  unchanged: number
  simplified: boolean
}

export type DisplayDiffLine = DiffLine | {
  kind: 'omitted'
  count: number
}

export interface ReviewChange {
  before: string
  after: string
  diff: LineDiff
  displayLines: DisplayDiffLine[]
}

const MAX_LCS_CELLS = 600_000

/** Build the exact body preview used by candidate approval, plus a line diff. */
export function createReviewChange(
  action: 'create' | 'update' | 'conflict',
  currentBody: string,
  candidateBody: string,
  changeKind: 'append' | 'revise' = 'append',
): ReviewChange {
  const before = action === 'create' ? '' : currentBody
  const after = action === 'create' || changeKind === 'revise'
    ? candidateBody.trim()
    : mergeKnowledgeBodies(currentBody, candidateBody)
  const diff = createLineDiff(before, after)
  return { before, after, diff, displayLines: compactDiffLines(diff.lines) }
}

/**
 * Produce a stable line diff. Large middle sections fall back to remove/add
 * blocks after common prefix and suffix trimming, bounding memory usage.
 */
export function createLineDiff(before: string, after: string): LineDiff {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < oldLines.length - prefix
    && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix)
  const newMiddle = newLines.slice(prefix, newLines.length - suffix)
  const cellCount = (oldMiddle.length + 1) * (newMiddle.length + 1)
  const simplified = cellCount > MAX_LCS_CELLS
  const middle = simplified
    ? simpleReplacement(oldMiddle, newMiddle, prefix + 1, prefix + 1)
    : lcsDiff(oldMiddle, newMiddle, prefix + 1, prefix + 1)

  const lines: DiffLine[] = []
  for (let index = 0; index < prefix; index += 1) {
    lines.push({ kind: 'context', text: oldLines[index] ?? '', oldLine: index + 1, newLine: index + 1 })
  }
  lines.push(...middle)
  for (let index = 0; index < suffix; index += 1) {
    const oldIndex = oldLines.length - suffix + index
    const newIndex = newLines.length - suffix + index
    lines.push({
      kind: 'context',
      text: oldLines[oldIndex] ?? '',
      oldLine: oldIndex + 1,
      newLine: newIndex + 1,
    })
  }

  let additions = 0
  let deletions = 0
  let unchanged = 0
  for (const line of lines) {
    if (line.kind === 'add') additions += 1
    else if (line.kind === 'remove') deletions += 1
    else unchanged += 1
  }
  return { lines, additions, deletions, unchanged, simplified }
}

/** Keep only nearby context, mirroring a compact source-control diff. */
export function compactDiffLines(lines: DiffLine[], contextSize = 3): DisplayDiffLine[] {
  if (lines.length === 0) return []
  const changed = lines.flatMap((line, index) => line.kind === 'context' ? [] : [index])
  if (changed.length === 0) {
    return collapseRanges(lines, [
      [0, Math.min(lines.length, contextSize)],
      [Math.max(0, lines.length - contextSize), lines.length],
    ])
  }

  const ranges = changed.map(index => [Math.max(0, index - contextSize), Math.min(lines.length, index + contextSize + 1)] as [number, number])
  const merged: Array<[number, number]> = []
  for (const range of ranges) {
    const previous = merged.at(-1)
    if (previous !== undefined && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
    else merged.push(range)
  }
  return collapseRanges(lines, merged)
}

function splitLines(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, '\n')
  return normalized.length === 0 ? [] : normalized.split('\n')
}

function lcsDiff(oldLines: string[], newLines: string[], oldStart: number, newStart: number): DiffLine[] {
  const columns = newLines.length + 1
  const table = new Uint32Array((oldLines.length + 1) * columns)
  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      const index = oldIndex * columns + newIndex
      table[index] = oldLines[oldIndex] === newLines[newIndex]
        ? (table[(oldIndex + 1) * columns + newIndex + 1] ?? 0) + 1
        : Math.max(table[(oldIndex + 1) * columns + newIndex] ?? 0, table[index + 1] ?? 0)
    }
  }

  const result: DiffLine[] = []
  let oldIndex = 0
  let newIndex = 0
  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push({ kind: 'context', text: oldLines[oldIndex] ?? '', oldLine: oldStart + oldIndex, newLine: newStart + newIndex })
      oldIndex += 1
      newIndex += 1
    } else if ((table[(oldIndex + 1) * columns + newIndex] ?? 0) >= (table[oldIndex * columns + newIndex + 1] ?? 0)) {
      result.push({ kind: 'remove', text: oldLines[oldIndex] ?? '', oldLine: oldStart + oldIndex })
      oldIndex += 1
    } else {
      result.push({ kind: 'add', text: newLines[newIndex] ?? '', newLine: newStart + newIndex })
      newIndex += 1
    }
  }
  while (oldIndex < oldLines.length) {
    result.push({ kind: 'remove', text: oldLines[oldIndex] ?? '', oldLine: oldStart + oldIndex })
    oldIndex += 1
  }
  while (newIndex < newLines.length) {
    result.push({ kind: 'add', text: newLines[newIndex] ?? '', newLine: newStart + newIndex })
    newIndex += 1
  }
  return result
}

function simpleReplacement(oldLines: string[], newLines: string[], oldStart: number, newStart: number): DiffLine[] {
  return [
    ...oldLines.map((text, index): DiffLine => ({ kind: 'remove', text, oldLine: oldStart + index })),
    ...newLines.map((text, index): DiffLine => ({ kind: 'add', text, newLine: newStart + index })),
  ]
}

function collapseRanges(lines: DiffLine[], ranges: Array<[number, number]>): DisplayDiffLine[] {
  const result: DisplayDiffLine[] = []
  let cursor = 0
  for (const [start, end] of ranges) {
    if (end <= cursor) continue
    const effectiveStart = Math.max(start, cursor)
    if (effectiveStart > cursor) result.push({ kind: 'omitted', count: effectiveStart - cursor })
    result.push(...lines.slice(effectiveStart, end))
    cursor = end
  }
  if (cursor < lines.length) result.push({ kind: 'omitted', count: lines.length - cursor })
  return result
}
