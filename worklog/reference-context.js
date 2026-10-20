import { normalizeReferences } from './references.js'

export const referenceAlias = index => `R${String(index + 1).padStart(3, '0')}`

/** Aliases are local to one generation, including each merge level. */
export function referenceContext(payload) {
  const aliases = new Map(payload.records.map((record, index) => [record.id, referenceAlias(index)]))
  const originals = new Map([...aliases].map(([id, alias]) => [alias, id]))
  if (aliases.size !== payload.records.length) throw new Error('Duplicate worklog sources')
  const remap = text => normalizeReferences(text, new Set(aliases.keys())).replace(/\[依据:([^\]]+)\]/g, (_, id) => `[依据:${aliases.get(id)}]`)
  const material = payload.material
    ? payload.material.map(item => ({ text: remap(item.text), ids: item.ids.map(id => aliases.get(id)) }))
    : payload.records.map(({ route, originalId, sourceId, sessionId, ...record }) => ({ ...record, id: aliases.get(record.id) }))
  // Accept exact original IDs for old mocks/providers; never accept approximate IDs.
  // Alias collisions with original IDs are resolved in favor of the model-facing alias.
  const accepted = new Set([...originals.keys(), ...aliases.keys()])
  function restore(output) {
    return normalizeReferences(output, accepted).replace(/\[依据:([^\]]+)\]/g, (_, id) => `[依据:${originals.get(id) || id}]`)
  }
  function quoteExists(id, quote) {
    if (typeof quote !== 'string' || quote.trim().length < 8 || quote.length > 500) return false
    const real = originals.get(id)
    if (!real) return false
    if (payload.material) return payload.material.some(item => item.ids.includes(real) && item.text.includes(quote))
    const record = payload.records.find(record => record.id === real)
    return [record?.user, record?.answer].some(text => typeof text === 'string' && text.includes(quote))
  }
  return { material, accepted, restore, quoteExists, originals }
}

/** A repair can replace only offending markers, with literal source evidence. */
export function applyReferenceRepair(output, response, failure, context) {
  const parsed = JSON.parse(response.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```$/, ''))
  const repairs = parsed.repairs
  if (!Array.isArray(repairs) || repairs.length !== failure.total || failure.total > 12) throw new Error('repair_shape')
  const byIndex = new Map(repairs.map(repair => [repair.index, repair]))
  if (byIndex.size !== repairs.length) throw new Error('repair_duplicate')
  let result = output
  for (const issue of [...failure.issues].sort((a, b) => b.index - a.index)) {
    const repair = byIndex.get(issue.index)
    if (!issue.length || !repair || !Array.isArray(repair.sources) || !repair.sources.length || repair.sources.length > 20) throw new Error('repair_shape')
    const ids = repair.sources.map(source => source.id)
    if (ids.some(id => !context.originals.has(id)) || repair.sources.some(source => !context.quoteExists(source.id, source.quote))) throw new Error('repair_evidence')
    if (issue.known.some(id => !ids.some(alias => alias === id || context.originals.get(alias) === id))) throw new Error('repair_removed_source')
    result = result.slice(0, issue.index) + [...new Set(ids)].map(id => `[依据:${id}]`).join('') + result.slice(issue.index + issue.length)
  }
  return context.restore(result)
}

// Only bounded, redacted details are persisted; ordinary logs never receive this.
function redacted(value, max) {
  return String(value || '').replace(/\b(?:Bearer\s+|sk-)[\w.\-]+/gi, '[已隐藏凭据]')
    .replace(/((?:password|passwd|token|api[_-]?key|secret|密码|密钥)["']?\s*[=:：]\s*["']?)[^\s"',，;；\]}&]+/gi, '$1[已隐藏凭据]').slice(0, max)
}
export function privateFailure(failure) {
  return { total: failure.total, repairAttempted: !!failure.repairAttempted, repairResult: failure.repairResult || 'not_attempted',
    issues: failure.issues.map(({ line, reference, excerpt, code }) => ({ line, reference: redacted(reference, 240), excerpt: redacted(excerpt, 500), code })) }
}
