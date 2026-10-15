/** Normalize model formatting, never repair or guess a source identity. */
export function normalizeReferences(output, ids) {
  const marker = /\[依据\s*[:：]([^\]]*)\]/g
  const invalid = (code, groupedReference = false) => {
    const message = code === 'invalid_reference'
      ? '日报来源引用校验失败：引用了输入素材中不存在的记录编号'
      : '日报来源引用格式错误：编号为空或括号未闭合'
    return Object.assign(new Error(message), {
      worklogDiagnostic: { code, outputChars: output.length, groupedReference, retryable: false },
    })
  }
  if (/\[依据\s*[:：]/.test(output.replace(marker, ''))) throw invalid('invalid_reference_format')
  return output.replace(marker, (_, raw) => {
    // Exact identities win: an actual ID may itself contain a separator.
    const trimmed = raw.trim()
    const parts = ids.has(raw) ? [raw] : ids.has(trimmed) ? [trimmed]
      : trimmed.split(/[,，、;；\s]+/).filter(Boolean)
    if (!parts.length) throw invalid('invalid_reference_format')
    if (parts.some(id => !ids.has(id))) throw invalid('invalid_reference', parts.length > 1)
    return [...new Set(parts)].map(id => `[依据:${id}]`).join('')
  })
}
