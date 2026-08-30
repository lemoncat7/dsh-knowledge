import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadServiceSettings, serviceSettingsPath, storeServiceSettings } from '../lib/service-settings.js'

test('client-local service and write-back model settings persist in a private atomic file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = serviceSettingsPath(join(root, 'connection.json'))
  assert.equal(loadServiceSettings(path), undefined)
  await storeServiceSettings(path, { publicApiEnabled: true, writebackProvider: 'cli', writebackModel: 'gpt-5.6-luna' })
  assert.deepEqual(loadServiceSettings(path), {
    publicApiEnabled: true,
    writebackProvider: 'cli',
    writebackModel: 'gpt-5.6-luna',
  })
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600)
})
