import assert from 'node:assert/strict'
import test from 'node:test'
import { mapConcurrent } from '../lib/async-pool.js'

test('bounded async mapping preserves order without exceeding its concurrency limit', async () => {
  let active = 0
  let peak = 0
  const results = await mapConcurrent([5, 4, 3, 2, 1, 0], 3, async value => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, value))
    active -= 1
    return value * 2
  })

  assert.equal(peak, 3)
  assert.deepEqual(results, [10, 8, 6, 4, 2, 0])
})
