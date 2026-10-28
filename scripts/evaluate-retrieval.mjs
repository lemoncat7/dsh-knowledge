import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'

// No production database is opened and no text is sent to a model or network.
// Custom input uses the same documents/questions schema as the checked-in fixture.
const fixture = JSON.parse(await readFile(process.argv[2] ?? new URL('../test/fixtures/retrieval-evaluation.json', import.meta.url), 'utf8'))
const root = await mkdtemp(join(tmpdir(), 'knowledge-evaluation-'))
const provider = new LocalKnowledgeProvider(join(root, 'knowledge.sqlite'))
const ids = new Map(), documents = new Map()
const percentile = values => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * .95) - 1)] ?? 0
try {
  for (const doc of fixture.documents) {
    const entry = await provider.create({ knowledgeBaseId: 'default', group: '评测', type: 'procedure', confidence: .9,
      title: doc.title, body: doc.body + (doc.paddingParagraphs ? '\n\n🧭这是不含目标关键词的背景段落。'.repeat(doc.paddingParagraphs) : '') + (doc.suffix ?? ''),
      tags: doc.tags ?? [], scope: doc.scope ?? { kind: 'global' } })
    ids.set(doc.key, entry.id); documents.set(entry.id, doc)
  }
  provider.retrievalIndex.close() // Deterministic benchmark: no worker races either mode.
  // processBatch intentionally stops when closed, so use a separate lifecycle-managed index.
  const { RetrievalIndex } = await import('../lib/retrieval-index.js')
  const index = new RetrievalIndex(provider.db)
  try { while (index.processBatch(20)) {} } finally { index.close() }
  const indexedAt = provider.db.prepare('SELECT max(indexed_at) AS at FROM knowledge_passage_index').get().at
  const run = async () => {
    const latencies = [], chars = [], idsPerQuery = []
    let hits = 0, answerable = 0, reciprocal = 0, evidence = 0, evidenceChecks = 0, leaks = 0, indexed = 0, returned = 0, invalidLocations = 0
    let recall = 0, precision = 0, ndcg = 0, emptyChecks = 0, correctEmpty = 0
    for (let round = 0; round < 12; round++) {
      for (const question of fixture.questions) {
        const expected = question.expected.map(key => {
          if (!ids.has(key)) throw Error('Unknown expected document key')
          return ids.get(key)
        })
        const start = performance.now()
        const results = await provider.search({ text: question.query, includePassage: true, limit: 5, projectId: question.projectId,
          excludeTags: question.excludeTags, includeTags: question.includeTags, knowledgeBaseIds: ['default'] })
        if (round >= 2) latencies.push(performance.now() - start)
        if (round) continue
        const rank = results.findIndex(hit => expected.includes(hit.entry.id))
        if (expected.length) { answerable++; if (rank >= 0) { hits++; reciprocal += 1 / (rank + 1) } }
        const relevant = results.filter(hit => expected.includes(hit.entry.id)).length
        if (expected.length) {
          recall += relevant / expected.length
          precision += relevant / Math.max(1, results.length)
          const dcg = results.reduce((sum, hit, i) => sum + (expected.includes(hit.entry.id) ? 1 / Math.log2(i + 2) : 0), 0)
          const ideal = Array.from({ length: Math.min(5, expected.length) }, (_, i) => 1 / Math.log2(i + 2)).reduce((a, b) => a + b, 0)
          ndcg += dcg / ideal
        } else { emptyChecks++; if (!results.length) correctEmpty++ }
        if (question.evidence) { evidenceChecks++; if (results.some(hit => expected.includes(hit.entry.id) && hit.passage.text.includes(question.evidence))) evidence++ }
        idsPerQuery.push(results.map(hit => hit.entry.id))
        chars.push(results.reduce((sum, hit) => sum + Array.from(hit.passage.text).length, 0))
        for (const hit of results) {
          returned++; if (hit.retrieval.source === 'index') indexed++
          const source = documents.get(hit.entry.id)
          if (source.scope?.kind === 'project' && source.scope.id !== question.projectId) leaks++
          if (source.tags?.some(tag => question.excludeTags?.includes(tag))) leaks++
          if (question.includeTags?.length && !source.tags?.some(tag => question.includeTags.includes(tag))) leaks++
          const passage = hit.passage
          if (Array.from(hit.entry.body).slice(passage.offset, passage.endOffset).join('') !== passage.text
            || passage.startLine !== 1 + (Array.from(hit.entry.body).slice(0, passage.offset).join('').match(/\n/g)?.length ?? 0)
            || passage.endLine !== passage.startLine + (passage.text.match(/\n/g)?.length ?? 0)
            || Array.from(passage.text).length > 420) invalidLocations++
        }
      }
    }
    return { hitRateAt5: hits / Math.max(1, answerable), recallAt5: recall / Math.max(1, answerable), precisionAt5: precision / Math.max(1, answerable),
      ndcgAt5: ndcg / Math.max(1, answerable), emptyQueryAccuracy: correctEmpty / Math.max(1, emptyChecks),
      mrrAt5: reciprocal / Math.max(1, answerable), evidenceCoverage: evidence / Math.max(1, evidenceChecks),
      permissionLeaks: leaks, invalidLocations, p95Ms: +percentile(latencies).toFixed(3), p95SnippetChars: percentile(chars),
      indexedHitRatio: indexed / Math.max(1, returned), idsPerQuery }
  }
  const indexed = await run()
  provider.db.exec("UPDATE knowledge_passage_index SET state='pending'")
  const fallback = await run()
  const sameCandidates = JSON.stringify(indexed.idsPerQuery) === JSON.stringify(fallback.idsPerQuery)
  delete indexed.idsPerQuery; delete fallback.idsPerQuery
  const result = { dataset: process.argv[2] ? 'custom-local' : 'synthetic-regression', documents: ids.size, questions: fixture.questions.length,
    sameCandidates, indexed, fallback, indexBuilt: Boolean(indexedAt) }
  console.log(JSON.stringify(result, null, 2))
  if (!sameCandidates || indexed.permissionLeaks || fallback.permissionLeaks || indexed.invalidLocations || fallback.invalidLocations
    || indexed.indexedHitRatio !== 1 || indexed.recallAt5 < fallback.recallAt5 || indexed.evidenceCoverage < fallback.evidenceCoverage) process.exitCode = 1
} finally { await provider.close(); await rm(root, { recursive: true, force: true }) }
