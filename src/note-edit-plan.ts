export const MAX_NOTE_EDIT_CHARS = 200_000
export interface NoteChangeLocation { section: string; startLine: number; endLine: number; beforeChars: number; afterChars: number }
export interface NoteMutationPreview { text: string; changeCount: number; locations: NoteChangeLocation[] }
interface Edit { start: number; end: number; oldText: string; newText: string }

function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > MAX_NOTE_EDIT_CHARS) throw new Error(`${field} must be a string of at most ${MAX_NOTE_EDIT_CHARS} characters`)
  return value
}

function anchor(original: string, oldText: string, newText: string, index: number): Edit {
  if (!oldText.trim()) throw new Error(`第 ${index} 处局部替换必须提供非空原文，不接受空行定位`)
  const start = original.indexOf(oldText)
  if (start < 0 || original.indexOf(oldText, start + 1) >= 0) throw new Error(`第 ${index} 处原文必须精确且唯一匹配，请重新读取并补足上下文；未生成提案，未应用任何修改`)
  return { start, end: start + oldText.length, oldText, newText }
}

function block(value: string): string {
  if (!value) return '（空）'
  let length = 3
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1)
  const fence = '`'.repeat(length)
  return `${fence}text\n${value}\n${fence}`
}

function noteLocator(original: string) {
  let cursor = 0, lineNumber = 0, section = '正文（无章节标题）', fence: string | undefined
  // Edits are ordered, so scan only once even for 100 edits in a long note.
  return (offset: number) => {
    while (cursor <= offset && cursor <= original.length) {
      const end = original.indexOf('\n', cursor)
      const line = original.slice(cursor, end < 0 ? original.length : end)
      cursor = end < 0 ? original.length + 1 : end + 1
      lineNumber++
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1]
      if (marker) {
        if (!fence) fence = marker
        else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined
      } else if (!fence) {
        const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1]
        if (heading) section = heading.slice(0, 160)
      }
    }
    return { section, lineNumber }
  }
}

/** Validate every anchor against the SAME snapshot; apply once, never partially.
 * In particular a later edit cannot accidentally match text created by an earlier edit. */
export function planNoteContentUpdate(original: string, operation: string, args: Record<string, unknown>): { content: string; summary: string; preview: NoteMutationPreview } {
  let edits: Edit[], content: string
  if (operation === 'batch_edit' || operation === 'replace_range') {
    const input = operation === 'batch_edit' ? args.edits : [{ oldText: args.oldText, newText: args.value }]
    if (!Array.isArray(input) || input.length < 1 || input.length > 100) throw new Error('edits 必须包含 1–100 处修改；同一请求的多个章节请合并在一次 batch_edit 中')
    if (operation === 'batch_edit' && (args.value !== undefined || args.oldText !== undefined)) throw new Error('batch_edit 只使用 edits，不要同时提供 value 或 oldText')
    let total = 0
    edits = input.map((item: unknown, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`edits[${index}] must be an object`)
      const entry = item as Record<string, unknown>
      const oldText = text(entry.oldText, `edits[${index}].oldText`), newText = text(entry.newText, `edits[${index}].newText`)
      total += oldText.length + newText.length
      if (total > MAX_NOTE_EDIT_CHARS * 2) throw new Error('本次修改内容合计超过 400000 字符，请缩小修改范围')
      return anchor(original, oldText, newText, index + 1)
    }).sort((a, b) => a.start - b.start)
    for (let i = 1; i < edits.length; i++) if (edits[i]!.start < edits[i - 1]!.end) throw new Error(`第 ${i}、${i + 1} 处修改范围重叠，请合并成一个修改项；未应用任何修改`)
    edits = edits.filter(edit => edit.oldText !== edit.newText)
    const pieces: string[] = []
    let cursor = 0
    for (const edit of edits) { pieces.push(original.slice(cursor, edit.start), edit.newText); cursor = edit.end }
    content = pieces.join('') + original.slice(cursor)
  } else {
    if (args.edits !== undefined) throw new Error('edits 仅用于 batch_edit')
    const value = text(args.value, 'value')
    if (operation === 'append_content') {
      edits = [{ start: original.length, end: original.length, oldText: '', newText: value }]
      content = original + value
    } else if (operation === 'replace_content') {
      if (original.length > MAX_NOTE_EDIT_CHARS) throw new Error('原文超过 200000 字符，无法提供有界的整篇覆盖预览，请使用一次 batch_edit 合并所需修改')
      content = value
      // Trim identical complete lines from the preview, not from saved content.
      let prefix = 0, suffix = 0
      while (prefix < original.length && prefix < value.length && original[prefix] === value[prefix]) prefix++
      const start = prefix ? original.lastIndexOf('\n', prefix - 1) + 1 : 0
      while (suffix < original.length - start && suffix < value.length - start && original[original.length - suffix - 1] === value[value.length - suffix - 1]) suffix++
      const nextLine = original.indexOf('\n', original.length - suffix)
      const end = nextLine < 0 ? original.length : nextLine + 1
      const valueEnd = value.length - (original.length - end)
      edits = [{ start, end, oldText: original.slice(start, end), newText: value.slice(start, valueEnd) }]
    } else throw new Error('unsupported note content operation')
  }
  if (content.replace(/\s/gu, '') === original.replace(/\s/gu, '')) throw new Error('内容未变化或仅有空白变化，不生成待确认提案')
  const locate = noteLocator(original)
  const locations = edits.map(edit => {
    const start = locate(edit.start), end = locate(Math.max(edit.start, edit.end - 1))
    return { section: start.section, startLine: start.lineNumber, endLine: end.lineNumber, beforeChars: edit.oldText.length, afterChars: edit.newText.length }
  })
  const preserved = original.length - edits.reduce((sum, edit) => sum + edit.oldText.length, 0)
  const summary = operation === 'replace_content'
    ? '整篇覆盖：按本次要求整体重写；下方省略首尾完全相同的行，中间修改区展示前后内容'
    : operation === 'append_content' ? '末尾追加（不会删除或合并已有章节）'
      : `局部替换：合并 ${edits.length} 处修改，一次确认、整体保存；范围外 ${preserved} 字符原样保留`
  const preview = edits.map((edit, index) => {
    const at = locations[index]!
    return `### 修改 ${index + 1} · ${at.section}\n原文第 ${at.startLine}–${at.endLine} 行；${at.beforeChars} → ${at.afterChars} 字符\n\n修改前：\n${block(edit.oldText)}\n\n修改后：\n${block(edit.newText)}`
  }).join('\n\n')
  return { content, summary, preview: { text: preview, changeCount: edits.length, locations } }
}
