import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadServiceSettings, serviceSettingsPath, storeServiceSettings } from '../lib/service-settings.js'

test('public API state persists in a private atomic settings file', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-knowledge-service-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const path = serviceSettingsPath(join(root, 'connection.json'))
  assert.equal(loadServiceSettings(path), undefined)
  await storeServiceSettings(path, { publicApiEnabled: true })
  assert.deepEqual(loadServiceSettings(path), { publicApiEnabled: true })
  assert.equal((await stat(path)).mode & 0o777, 0o600)
})
