import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runWikiChangeCheck, startWikiChangeWatch } from '../lib/wiki/change-watch.js'
import { resolveConfig } from '../lib/config.js'

function fakeWiki({ bases, states = {}, running = {}, fail = {}, onCheck }) {
  return {
    list: () => bases.map(kbId => ({ kbId, layout: {}, conversationEnabled: false })),
    connectionStatus: kbId => ({ state: states[kbId] ?? 'ready' }),
    ingest: {
      running: kbId => Boolean(running[kbId]),
      changes: async kbId => {
        if (fail[kbId]) throw new Error('injected failure')
        onCheck?.(kbId)
        return { new: [], changed: [], missing: [], scannedAt: 'now' }
      },
    },
  }
}

function logger() { const lines = []; return { lines, warn: message => lines.push(message) } }

test('scheduled checks only touch connected bases, skip running jobs and log failures', async () => {
  const checked = [], log = logger()
  const wiki = fakeWiki({
    bases: ['ready', 'partial', 'configured', 'busy', 'broken'],
    states: { configured: 'configured' },
    running: { busy: true },
    fail: { broken: true },
    onCheck: kbId => checked.push(kbId),
  })

  const summary = await runWikiChangeCheck(wiki, log)

  assert.deepEqual(summary.checked, ['ready', 'partial'])
  assert.deepEqual(summary.skipped, ['busy'], 'a running ingest job skips its base for this round')
  assert.deepEqual(summary.failed, ['broken'])
  assert.deepEqual(checked, ['ready', 'partial'])
  assert.match(log.lines.join('\n'), /broken/, 'failures are logged instead of thrown')
})

test('the watcher runs on its interval, never overlaps itself and stops on dispose', async () => {
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const dispose = startWikiChangeWatch(async () => { calls += 1; await gate }, 20)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(calls, 1, 'a slow round must not overlap itself')
  release()
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.ok(calls >= 2, 'the next round runs after the slow one settles')
  dispose()
  const settled = calls
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal(calls, settled, 'dispose stops the interval')
})

test('the change-check interval defaults to 15 minutes and 0 disables it', () => {
  const base = { backend: 'local', databasePath: join(tmpdir(), 'config-probe.sqlite') }
  assert.equal(resolveConfig(base).wikiChangeCheckMinutes, 15)
  assert.equal(resolveConfig({ ...base, wikiChangeCheckMinutes: 0 }).wikiChangeCheckMinutes, 0)
  assert.equal(resolveConfig({ ...base, wikiChangeCheckMinutes: 30 }).wikiChangeCheckMinutes, 30)
  assert.equal(startWikiChangeWatch(async () => {}, 0)(), undefined, '0 disables the watcher')
})
