import { parseCitation } from './knowledge-citations.js'
import { entryMatchesMount } from './retrieval.js'
import { knowledgeDocumentPath } from './documents/path.js'
import type { KnowledgeProvider } from './provider.js'

const fail = (status: number, message: string) => Object.assign(new Error(message), { status })

/** Every click rechecks the source, current mount/tag/project policy and version. */
export async function readCitation(provider: KnowledgeProvider, raw: string, sessionId: string, sourceKey: () => string) {
  const citation = parseCitation(raw)
  if (!citation || citation.sessionId !== sessionId) throw fail(400, '来源引用格式无效或会话不匹配，请从原回答重新打开。')
  const assertSource = () => { if (citation.sourceKey !== sourceKey()) throw fail(409, '知识库连接已切换，请恢复原连接后查看该来源。') }
  assertSource()
  const mounts = await provider.resolveMounts(sessionId, citation.projectId)
  const mount = mounts.find(item => item.knowledgeBaseId === citation.knowledgeBaseId && item.recallEnabled)
  if (!mount) throw fail(403, '原会话已取消这份知识的召回访问，无法查看来源。')
  const entry = await provider.get(citation.documentId)
  assertSource()
  if (!entry || entry.status !== 'active' || entry.knowledgeBaseId !== citation.knowledgeBaseId
    || !entryMatchesMount(entry, mount, citation.projectId)) throw fail(404, '来源文档已删除、归档或不在当前会话可访问范围。')
  if (entry.version !== citation.version) throw fail(409, `来源引用的是 v${citation.version}，当前文档已更新为 v${entry.version}。为避免定位错误，未使用旧行号；请重新检索获取新版引用。`)
  const lines = entry.body.split('\n')
  if (citation.startLine > lines.length || citation.endLine > lines.length) throw fail(400, '来源行号超出文档范围，请重新检索。')
  const from = Math.max(1, citation.startLine - 8), to = Math.min(lines.length, citation.endLine + 8, from + 399)
  // Bounded human preview even for a one-line, exceptionally large document.
  let remaining = 80_000
  const excerpt = lines.slice(from - 1, to).map((text, i) => {
    const display = text.slice(0, remaining)
    remaining -= display.length
    return { number: from + i, text: display, clipped: display.length < text.length }
  })
  const headings: { level: number; text: string }[] = []
  let fence = ''
  for (const line of lines.slice(0, citation.startLine)) {
    const delimiter = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (delimiter) {
      if (!fence) fence = delimiter[1]!
      else if (delimiter[1]![0] === fence[0] && delimiter[1]!.length >= fence.length && !delimiter[2]!.trim()) fence = ''
      continue
    }
    if (fence) continue
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading) {
      while (headings.length && headings.at(-1)!.level >= heading[1]!.length) headings.pop()
      headings.push({ level: heading[1]!.length, text: heading[2]! })
    }
  }
  return { title: entry.title, path: `${mount.base.name}/${knowledgeDocumentPath(entry)}`, version: entry.version,
    section: headings.map(item => item.text).join(' / '), startLine: citation.startLine, endLine: citation.endLine,
    totalLines: lines.length, lines: excerpt, truncated: to < citation.endLine || excerpt.some(line => line.clipped) }
}
