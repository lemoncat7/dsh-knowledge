import assert from 'node:assert/strict'
import test from 'node:test'
import { compactDiffLines, createLineDiff, createReviewChange } from '../lib/web-change-review.js'

test('create review marks a new document as additions', () => {
  const review = createReviewChange('create', '', '# DSH\n\nA harness.')
  assert.equal(review.before, '')
  assert.equal(review.after, '# DSH\n\nA harness.')
  assert.deepEqual(
    { additions: review.diff.additions, deletions: review.diff.deletions, unchanged: review.diff.unchanged },
    { additions: 3, deletions: 0, unchanged: 0 },
  )
  assert.ok(review.displayLines.every(line => line.kind === 'add'))
})

test('update review previews the same append merge used by the provider', () => {
  const review = createReviewChange('update', '# Project\n\nExisting fact.', 'New verified fact.')
  assert.equal(review.after, '# Project\n\nExisting fact.\n\nNew verified fact.')
  assert.equal(review.diff.additions, 2)
  assert.equal(review.diff.deletions, 0)
  assert.equal(review.diff.unchanged, 3)
})

test('revision review shows actual replacement and deletion lines', () => {
  const review = createReviewChange(
    'update',
    '# Runtime\n\nVersion 1.2 is supported.\n\nLegacy fallback is enabled.',
    '# Runtime\n\nVersion 1.3 is supported.',
    'revise',
  )
  assert.equal(review.after, '# Runtime\n\nVersion 1.3 is supported.')
  assert.equal(review.diff.additions, 1)
  assert.equal(review.diff.deletions, 3)
  assert.ok(review.displayLines.some(line => line.kind === 'remove'))
  assert.ok(review.displayLines.some(line => line.kind === 'add'))
})

test('line diff reports replacements with old and new line numbers', () => {
  const diff = createLineDiff('alpha\nbeta\ngamma', 'alpha\nupdated\ngamma')
  assert.equal(diff.additions, 1)
  assert.equal(diff.deletions, 1)
  assert.equal(diff.unchanged, 2)
  assert.deepEqual(diff.lines.map(line => line.kind), ['context', 'remove', 'add', 'context'])
  assert.equal(diff.lines[1].oldLine, 2)
  assert.equal(diff.lines[2].newLine, 2)
})

test('compact view folds distant unchanged lines', () => {
  const before = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join('\n')
  const after = before.replace('line 15', 'changed 15')
  const compact = compactDiffLines(createLineDiff(before, after).lines, 2)
  assert.ok(compact.some(line => line.kind === 'omitted'))
  assert.ok(compact.some(line => line.kind === 'remove'))
  assert.ok(compact.some(line => line.kind === 'add'))
})

test('large diffs use a bounded simplified comparison', () => {
  const before = Array.from({ length: 800 }, (_, index) => `old ${index}`).join('\n')
  const after = Array.from({ length: 800 }, (_, index) => `new ${index}`).join('\n')
  const diff = createLineDiff(before, after)
  assert.equal(diff.simplified, true)
  assert.equal(diff.deletions, 800)
  assert.equal(diff.additions, 800)
})
