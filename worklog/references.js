export function referenceParts(raw, ids) {
  const trimmed = raw.trim()
  return ids.has(raw) ? [raw] : ids.has(trimmed) ? [trimmed] : trimmed.split(/[,，、;；\s]+/).filter(Boolean)
}

// Private context is kept separate from log-safe diagnostic metadata.
export function referenceIssues(output, ids) {
  const issues = []
  const pattern = /\[依据\s*[:：]((?:(?!\[依据)[^\]])*)(\]|$)/g
  for (const match of output.matchAll(pattern)) {
    const parts = referenceParts(match[1], ids)
    if (match[2] && parts.length && parts.every(id => ids.has(id))) continue
    const index = match.index
    issues.push({ index, length: match[0].length, line: output.slice(0, index).split('\n').length,
      reference: match[1], excerpt: output.slice(Math.max(0, index - 180), Math.min(output.length, index + match[0].length + 80)),
      code: !match[2] || !parts.length ? 'invalid_reference_format' : 'invalid_reference',
      known: parts.filter(id => ids.has(id)), grouped: parts.length > 1 })
  }
  // A nested/unclosed marker may not match the bounded parser; never let it pass.
  const remaining = output.replace(/\[依据\s*[:：]([^\]]*)\]/g, '')
  if (/\[依据\s*[:：]/.test(remaining) && !issues.some(issue => issue.code === 'invalid_reference_format')) {
    const index = output.indexOf('[依据')
    issues.push({ index, length: 0, line: output.slice(0, index).split('\n').length, reference: '', excerpt: output.slice(index, index + 260), code: 'invalid_reference_format', known: [] })
  }
  return issues
}

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
  const issues = referenceIssues(output, ids)
  if (issues.length) {
    const first = issues.find(issue => issue.code === 'invalid_reference_format') || issues[0]
    const error = invalid(first.code, first.grouped)
    error.worklogFailure = { issues: issues.slice(0, 12), total: issues.length }
    throw error
  }
  return output.replace(marker, (_, raw) => {
    // Exact identities win: an actual ID may itself contain a separator.
    const parts = referenceParts(raw, ids)
    if (!parts.length) throw invalid('invalid_reference_format')
    if (parts.some(id => !ids.has(id))) throw invalid('invalid_reference', parts.length > 1)
    return [...new Set(parts)].map(id => `[依据:${id}]`).join('')
  })
}
