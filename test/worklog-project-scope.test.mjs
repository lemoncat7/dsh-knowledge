import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectInScope } from '../worklog/project-scope.js'
import { capture, defaults, settings } from '../worklog/domain.js'
import { Store } from '../worklog/store.js'
import { JournalService } from '../worklog/service.js'
import { Worker } from '../worklog/worker.js'

const config = { ...defaults, enabled: true, projects: ['/work'], recursiveProjects: true }

test('recursive project selection is opt-in and keeps legacy exact matching', () => {
  assert.equal(defaults.recursiveProjects, false)
  assert.equal(settings({ ...defaults, recursiveProjects: undefined }).recursiveProjects, false)
  assert.equal(settings(config).recursiveProjects, true)
  for (const value of [null, 0, 1, 'true', [], {}]) {
    assert.throws(() => settings({ ...config, recursiveProjects: value }), /包含子目录/)
  }
  for (const project of ['/work/', '/work/child', '/work/.', '/WORK']) {
    assert.equal(projectInScope(project, { ...config, recursiveProjects: false }), false, project)
  }
  assert.equal(projectInScope('/work', { ...config, recursiveProjects: undefined }), true)
  assert.equal(projectInScope('/work/child', { ...config, recursiveProjects: undefined }), false)
  assert.equal(projectInScope('/work', { ...config, projects: [] }), false)
  assert.equal(projectInScope('/elsewhere', { ...config, projects: [], scope: 'all' }), true)
})

test('recursive paths normalize segments and respect roots and directory boundaries', () => {
  const cases = [
    ['/work', '/work', true], ['/work', '/work/a/b', true], ['/work', '/workshop', false],
    ['/work/', '/work/a', true], ['/work//', '/work', true], ['/work', '/work//a', true],
    ['/work', '/work/./a', true], ['/work', '/work/a/../b', true],
    ['/work', '/work/../private', false], ['/work', '/work/a/../../private', false],
    ['/work/../private', '/private/a', true], ['/work/.', '/work/a', true],
    ['/', '/work', true], ['/', '/', true], ['/', 'relative', false],
    ['/work', '/WORK/a', false], ['/work', '/work\\child', false],
    ['/work', '/workspace/work', false], ['/work', '', false],
    ['D:\\work', 'd:\\WORK\\child', true], ['D:\\work', 'D:/work/a', true],
    ['D:/work/', 'd:\\work', true], ['D:/work', 'D:/workshop', false],
    ['D:/work', 'E:/work/a', false], ['D:/', 'd:\\work\\a', true],
    ['D:/work', 'D:/work/../private', false], ['D:/work', 'D:work/a', false],
    ['D:', 'D:/work', false], ['D:work', 'D:work/a', false],
    ['\\work', '\\work\\a', false], ['work', 'work/a', false],
    ['.', '/work', false], ['~', '~/work', false], ['work', 'work', true],
    ['\\\\server\\share', '//SERVER/SHARE/a', true],
    ['//server/share/', '\\\\server\\share\\a\\b', true],
    ['//server/share', '//server/share2/a', false],
    ['//server/share', '//other/share/a', false],
    ['//server/share/work', '//server/share/work/../private', false],
    ['//server/share', '//server/share/../a', true],
    ['//server', '//server/share/a', false],
    ['\\\\?\\D:\\work', '\\\\?\\D:\\work\\a', false],
    ['/', 'D:/work', false], ['/', '//server/share/a', false],
    ['/work', '/work/a\0b', false],
  ]
  for (const [parent, child, expected] of cases) {
    assert.equal(projectInScope(child, { ...config, projects: [parent] }), expected, `${parent} -> ${child}`)
  }
})

test('capture uses session cwd, preserves original path and keeps exclusions authoritative', () => {
  const session = { id: 's', header: { cwd: '/work/a/./child' }, snapshotEvents: () => [
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '任务' }] } },
    { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完成' }] } } },
  ] }
  assert.equal(capture(session, 1, { ...config, recursiveProjects: false }), null)
  assert.equal(capture(session, 1, config).project, session.header.cwd)
  assert.equal(capture(session, 1, { ...config, projects: ['/work', '/work/a'] }).id, 's:1')
  assert.equal(capture(session, 1, { ...config, excludedSessions: ['s'] }), null)
  assert.equal(capture(session, 1, { ...config, enabled: false }), null)
  assert.equal(capture(session, 1, { ...config, scope: 'all', excludedSessions: ['s'] }), null)
})

test('recursive setting persists across restart and old settings stay exact-only', t => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-recursive-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'journal.sqlite')
  let store = new Store(path)
  try {
    const { recursiveProjects, ...legacy } = config
    store.setMeta('settings', legacy)
    assert.equal(store.config().recursiveProjects, false)
    store.configure(config)
    store.close(); store = new Store(path)
    assert.equal(store.config().recursiveProjects, true)
    assert.deepEqual(store.config().projects, ['/work'])
  } finally { store.close() }
})

test('local browser settings round-trip the recursive switch without changing shared revision', async t => {
  const store = new Store(':memory:')
  const worker = new Worker(store, {}, async () => { throw new Error('not expected') })
  const service = new JournalService(store, worker, async () => [])
  t.after(async () => { await service.close(); store.close() })
  const before = await service.browser('GET', '/state')
  await service.browser('POST', '/settings', { ...config, sharedRevision: before.sharedRevision })
  const after = await service.browser('GET', '/state')
  assert.equal(after.config.recursiveProjects, true)
  assert.equal(after.sharedRevision, before.sharedRevision)
  assert.deepEqual(after.days, [], 'changing scope never scans history')
  await service.browser('POST', '/settings', { ...after.config, recursiveProjects: false, sharedRevision: after.sharedRevision })
  assert.equal((await service.browser('GET', '/state')).config.recursiveProjects, false)
})
