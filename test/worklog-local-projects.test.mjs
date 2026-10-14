import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../worklog/store.js'
import { Outbox } from '../worklog/outbox.js'

test('local project discovery is isolated from imports and manual notes', () => {
  const store = new Store(':memory:')
  try {
    store.observe('/local/project')
    store.importRecord({ id: 'remote', day: '2026-10-14', project: '/remote/project', sourceId: 'remote', excluded: false })
    store.note('2026-10-14', 'remote manual note', '/remote/note')
    assert.deepEqual(store.overview().projects, ['/local/project'])
    assert.equal(store.records('2026-10-14').length, 2, 'central material is untouched')
    store.observe('/remote/project')
    assert.deepEqual(store.overview().projects, ['/local/project', '/remote/project'], 'real local observation wins even when another machine uses the same path')
  } finally { store.close() }
})

test('legacy polluted catalog is repaired once without changing settings or reports', () => {
  const root = mkdtempSync(join(tmpdir(), 'local-projects-')), path = join(root, 'journal.sqlite')
  let store = new Store(path)
  try {
    const origin = store.originId()
    const config = store.configure({ ...store.config(), projects: ['/remote/project', '/manual'], excludedSessions: ['excluded'] })
    const record = (id, project, extra = {}) => ({ id, project, day: '2026-10-14', sessionId: 'session', ...extra })
    store.insert(record('legacy', '/legacy/local'))
    store.insert(record('local', '/shared', { sourceId: origin }))
    store.importRecord(record('import', '/shared', { sourceId: 'another-instance', originalId: 'remote', excluded: true }))
    store.importRecord(record('remote', '/remote/project', { sourceId: 'another-instance', excluded: false }))
    store.note('2026-10-14', 'note', '/remote/note')
    store.save('2026-10-14', '# Keep this report', 0)
    const outbox = new Outbox(store, () => ({}))
    outbox.add('offline', '/ingest', { record: record('pending', '/pending/local') })
    for (const project of ['/legacy/local', '/shared', '/remote/project', '/remote/note', '/observed/without-capture']) store.db.prepare('INSERT INTO projects VALUES (?)').run(project)
    // Simulate the old schema and marker state, including acknowledged outbox
    // entries whose original text has been intentionally discarded.
    store.db.exec("DROP TABLE local_projects; DELETE FROM meta WHERE key='localProjectsV1'")
    store.close(); store = new Store(path)
    assert.deepEqual(store.overview().projects, ['/legacy/local', '/observed/without-capture', '/pending/local', '/shared'])
    assert.deepEqual(store.config(), config)
    assert.equal(store.report('2026-10-14').markdown, '# Keep this report')
    assert.equal(store.records('2026-10-14', true).length, 5)
    store.observe('/new/local')
    store.db.prepare('INSERT INTO projects VALUES (?)').run('/stale/remote')
    store.close(); store = new Store(path)
    assert.ok(store.overview().projects.includes('/new/local'))
    assert.ok(!store.overview().projects.includes('/stale/remote'), 'legacy table is never re-imported')
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
