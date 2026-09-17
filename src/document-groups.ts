/** Group names are metadata, never filesystem paths or search permissions. */
export interface KnowledgeDocumentGroup { name: string; count: number }

export function normalizeDocumentGroup(value: unknown, required = false): string {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string') throw invalid('创建知识文档必须指定分组，请优先选择已有分组')
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ')
  if (/[\u0000-\u001f\u007f]/u.test(value) || name.length > 64) throw invalid('文档分组限 64 字，不能包含控制字符')
  if (required && (!name || name === '未分组')) throw invalid('创建知识文档必须指定有效分组，不能使用“未分组”')
  return name === '未分组' ? '' : name
}

export function matchDocumentGroup(value: string, existing: readonly string[]): string {
  const key = value.toLocaleLowerCase()
  return existing.find(name => name.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase() === key) ?? value
}

function invalid(message: string): Error { return Object.assign(new Error(message), { status: 400 }) }
