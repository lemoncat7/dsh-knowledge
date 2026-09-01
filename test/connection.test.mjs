import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadStoredConnection, storeConnection, validateConnectionSettings } from '../lib/connection.js'
import { KnowledgeProviderRouter } from '../lib/provider-router.js'

test('connection settings require HTTPS and a client token without exposing central servers', () => {
  assert.doesNotThrow(() => validateConnectionSettings({ backend: 'local', remoteTimeoutMs: 10000 }, false, true))
  assert.throws(() => validateConnectionSettings({ backend: 'local', remoteTimeoutMs: 10000 }, false, false), /databasePath/)
  assert.throws(() => validateConnectionSettings({
    backend: 'remote', remoteUrl: 'http://knowledge.example.com/api', remoteToken: 'x'.repeat(32), remoteTimeoutMs: 10000,
  }, false), /HTTPS/)
  assert.throws(() => validateConnectionSettings({
    backend: 'remote', remoteUrl: 'https://knowledge.example.com/api', remoteToken: 'short', remoteTimeoutMs: 10000,
  }, false), /24 characters/)
  assert.throws(() => validateConnectionSettings({
    backend: 'remote', remoteUrl: 'https://user:secret@knowledge.example.com/api', remoteToken: 'x'.repeat(32), remoteTimeoutMs: 10000,
  }, false), /must not contain credentials/)
  assert.throws(() => validateConnectionSettings({
    backend: 'remote', remoteUrl: 'https://knowledge.example.com/api?tenant=one', remoteToken: 'x'.repeat(32), remoteTimeoutMs: 10000,
  }, false), /query string or fragment/)
  assert.doesNotThrow(() => validateConnectionSettings({
    backend: 'remote', remoteUrl: 'https://knowledge.example.com/api', remoteToken: 'x'.repeat(32), remoteTimeoutMs: 10000,
  }, false))
  assert.throws(() => validateConnectionSettings({
    backend: 'remote', remoteUrl: 'https://knowledge.example.com/api', remoteToken: 'x'.repeat(32), remoteTimeoutMs: 10000,
  }, true), /central knowledge server/)
})

test('provider router lets in-flight calls finish before closing the retired provider', async () => {
  const events = []
  let release
  const pending = new Promise(resolve => { release = resolve })
  const provider = (mode, search) => new Proxy({ mode, close: async () => { events.push(`close:${mode}`) } }, {
    get(target, property) {
      if (property === 'search') return search
      if (property in target) return target[property]
      return async () => undefined
    },
  })
  const local = provider('local', async () => { events.push('search:start'); await pending; events.push('search:end'); return [] })
  const remote = provider('remote', async () => [])
  const router = new KnowledgeProviderRouter(local)
  const search = router.provider.search({ text: 'test' })
  const replacement = router.replace(remote)
  await Promise.resolve()
  assert.deepEqual(events, ['search:start'])
  release()
  await search
  await replacement
  assert.deepEqual(events, ['search:start', 'search:end', 'close:local'])
  assert.equal(router.provider.mode, 'remote')
  await router.close()
  assert.deepEqual(events, ['search:start', 'search:end', 'close:local', 'close:remote'])
})

test('provider router can borrow the management provider without closing shared storage', async () => {
  const closed = []
  const provider = mode => new Proxy({ mode, close: async () => { closed.push(mode) } }, {
    get(target, property) {
      if (property in target) return target[property]
      return async () => undefined
    },
  })
  const sharedLocal = provider('local')
  const remote = provider('remote')
  const router = new KnowledgeProviderRouter(sharedLocal, { owned: false })
  await router.replace(remote)
  assert.deepEqual(closed, [])
  await router.close()
  assert.deepEqual(closed, ['remote'])
  await sharedLocal.close()
  assert.deepEqual(closed, ['remote', 'local'])
})

test('connection settings survive restart in a private atomic file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-connection-'))
  const path = join(root, 'connection.json')
  t.after(() => rm(root, { recursive: true, force: true }))
  const settings = {
    backend: 'remote', remoteUrl: 'https://knowledge.example/api',
    remoteToken: 'restart_remote_token_longer_than_24_chars', remoteTimeoutMs: 7500,
  }
  await storeConnection(path, settings)
  assert.deepEqual(loadStoredConnection(path), settings)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  assert.match(await readFile(path, 'utf8'), /restart_remote_token/)
})
