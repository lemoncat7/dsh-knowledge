/** Human-readable explanations for Wiki rejections. Codes stay stable; reasons are for operators. */
export interface WikiExplanation { code: string; reason: string }
export interface WikiFailure { code: string; message: string }

const unknownCode = 'WIKI_PAGE_UNREADABLE'
const rejectionSuffix = '，因此未登记、不可检索；原文件未被改写'
const rejectionReasons: Record<string, string> = {
  INVALID_MARKDOWN: 'front matter 解析失败，读不出标题与来源',
  UNKNOWN_SCOPE: 'scope 字段不是受支持的 global / project 结构',
  UNKNOWN_PROVENANCE: 'provenance 字段不在允许取值内',
  INVALID_ARGUMENT: 'front matter 取值不合法（status 只能是 active / archived）',
  WIKI_PAGE_BODY_EMPTY: '页面正文为空',
  WIKI_PAGE_BODY_TOO_LONG: '正文超过 50000 字符',
  PATH_ESCAPE: '页面路径指向 Wiki 文件夹之外（可能是符号链接）',
  RESERVED_PATH: '页面路径命中保留名或非法字符',
}
const connectionReasons: Record<string, string> = {
  WIKI_SCOPE_REQUIRED: '未指定知识范围，请选择全局或具体项目',
  WIKI_DIRECTORY_REQUIRED: '未选择成文目录',
  WIKI_DIRECTORY_NAME_REQUIRED: '所选目录名不是 wiki',
  WIKI_RELOCATION_REQUIRES_DETACH: '该知识库已绑定其他目录，需先解绑再重新接入',
  WIKI_CROSS_BASE_OVERLAP: '所选目录与另一个 Wiki 知识库的目录重叠',
  WIKI_BASE_NOT_FOUND: '知识库不存在或已归档',
  WIKI_USE_EMPTY_BASE: '该知识库已有普通资料，请换一个空知识库接入',
  WIKI_RECOVERY_CONFLICT: '上次写入未完成且无法自动恢复，请检查 _meta 目录后重试',
  WIKI_PAGE_NOT_INDEXABLE: '已登记页面缺少标题或正文，无法建立索引',
  WIKI_EXTERNAL_EDIT_DURING_INDEX_FINALIZATION: '建立索引期间页面被外部修改，请重新接入',
  WIKI_BASE_ID_MISMATCH: '目录里的身份清单属于另一个知识库',
  WIKI_MANIFEST_INVALID: '身份清单无法解析，请检查 _meta/knowledge/manifest.json',
  WIKI_IMPORT_REQUIRES_RESOLUTION: '存在无法登记或过长页面，请先处理再完整导入',
  UNSAFE_ROOT: '所选目录是磁盘根目录或用户主目录，不能作为 Wiki 目录',
  OVERLAP: '源文件夹、Wiki 文件夹与 raw 文件夹不能互相包含',
}
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error ?? '') }
export function wikiErrorCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  if (typeof code === 'string' && code) return code
  const match = /^([A-Z][A-Z0-9_]{2,})(?::|：|$)/u.exec(messageOf(error))
  return match?.[1] ?? unknownCode
}
export function wikiErrorDetail(error: unknown): string | undefined {
  const detail = typeof error === 'object' && error !== null ? (error as { detail?: unknown }).detail : undefined
  return typeof detail === 'string' && detail ? detail : undefined
}
/** Explanation for one rejected page: stable code plus why it cannot be registered or searched. */
export function explainWikiRejection(input: unknown): WikiExplanation {
  const code = typeof input === 'string' ? input : wikiErrorCode(input)
  const base = rejectionReasons[code] ?? messageOf(input) ?? ''
  const detail = typeof input === 'string' ? undefined : wikiErrorDetail(input)
  const reason = base && base !== code ? base : '页面无法读取或解析'
  return { code, reason: (detail ? `${reason}（${detail}）` : reason) + rejectionSuffix }
}
/** Explanation for a failed connection attempt: code plus an operator-facing message. */
export function explainWikiFailure(error: unknown): WikiFailure {
  const code = wikiErrorCode(error), message = messageOf(error), reason = connectionReasons[code]
  if (!reason || message.includes('：')) return { code, message }
  return { code, message: `${code}：${reason}` }
}
