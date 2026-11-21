import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, truncate, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LocalKnowledgeProvider } from '../lib/local-provider.js'
import { registerKnowledgeApi } from '../lib/api.js'

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), 'wiki-scan-'))
  const provider = new LocalKnowledgeProvider(join(root, 'db.sqlite'))
  let handler
  registerKnowledgeApi({ webServer: { register(route) { handler = route.handler; return () => {} } } }, provider, '/test', { authMode: 'same-origin' })
  const server = createServer((req, res) => void handler(req, res))
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await provider.close(); await rm(root, { recursive: true, force: true, maxRetries: 5 }) })
  const base = await provider.createKnowledgeBase({ name: '扫描', description: '', defaultTags: [], extractionInstructions: '', writebackPolicy: 'conservative' })
  const endpoint = `http://127.0.0.1:${server.address().port}/test/wiki/${base.id}`
  const headers = { 'x-dsh-knowledge-client': 'management-web', 'content-type': 'application/json' }
  const sourceDir = join(root, 'source'), workspaceRoot = join(root, 'work')
  await mkdir(sourceDir); await mkdir(workspaceRoot)
  const connected = await fetch(endpoint + '/connect', { method: 'POST', headers, body: JSON.stringify({ sourceDir, workspaceRoot, scope: { kind: 'global' } }) })
  assert.equal(connected.status, 200)
  return { endpoint, headers, sourceDir }
}

test('scan preview reports folder deliveries apart from root-level files', async t => {
  const { endpoint, headers, sourceDir } = await harness(t)
  await writeFile(join(sourceDir, '根层原件.txt'), '根层资料正文，超过二十个字符以满足抽取质量判定要求。')
  await mkdir(join(sourceDir, '外部投递', '子目录'), { recursive: true })
  await writeFile(join(sourceDir, '外部投递', '甲.txt'), '甲资料正文，超过二十个字符以满足抽取质量判定要求。')
  await writeFile(join(sourceDir, '外部投递', '子目录', '乙.txt'), '乙资料正文，超过二十个字符以满足抽取质量判定要求。')

  const scan = await (await fetch(endpoint + '/scan', { method: 'POST', headers, body: '{}' })).json()
  assert.deepEqual(scan.files.map(file => file.name).sort(), ['乙.txt', '根层原件.txt', '甲.txt'].sort())
  assert.deepEqual(scan.files.filter(file => file.folder).map(file => [file.folder, file.relPath]).sort(),
    [['外部投递', '子目录/乙.txt'], ['外部投递', '甲.txt']].sort())
  assert.deepEqual(scan.folders, [{ name: '外部投递', count: 2 }])
  assert.deepEqual(scan.skipped, [])
})

test('scan preview explains oversized extractable files instead of dropping them silently', async t => {
  const { endpoint, headers, sourceDir } = await harness(t)
  const oversized = join(sourceDir, '外部投递', '超大扫描件.pdf')
  await mkdir(join(sourceDir, '外部投递'), { recursive: true })
  await writeFile(oversized, Buffer.alloc(64, 1)); await truncate(oversized, 257 * 1024 * 1024)
  await writeFile(join(sourceDir, '外部投递', '短片.mp4'), Buffer.alloc(1024, 2))

  const scan = await (await fetch(endpoint + '/scan', { method: 'POST', headers, body: '{}' })).json()
  // Register-only formats are listed regardless of size; extractable formats above the cap are explained.
  assert.deepEqual(scan.files.map(file => [file.name, file.folder]), [['短片.mp4', '外部投递']])
  assert.equal(scan.skipped.length, 1)
  assert.equal(scan.skipped[0].name, '超大扫描件.pdf')
  assert.equal(scan.skipped[0].size, 257 * 1024 * 1024)
  assert.equal(scan.skipped[0].folder, '外部投递')
  assert.equal(scan.skipped[0].relPath, '超大扫描件.pdf')
  assert.match(scan.skipped[0].reason, /256 MB/)
})

test('change detection refreshes over the management API and persists its report', async t => {
  const { endpoint, headers, sourceDir } = await harness(t)
  await writeFile(join(sourceDir, '新到资料.txt'), '新到资料正文，超过二十个字符以满足抽取质量判定要求。')
  const original = await readFile(join(sourceDir, '新到资料.txt'), 'utf8')

  const refreshed = await (await fetch(endpoint + '/changes', { method: 'POST', headers, body: '{}' })).json()

  assert.equal(refreshed.new.length, 1)
  assert.equal(refreshed.new[0].name, '新到资料.txt')
  assert.deepEqual([refreshed.changed, refreshed.missing, refreshed.skipped], [[], [], []])
  assert.equal(await readFile(join(sourceDir, '新到资料.txt'), 'utf8'), original, 'the check never rewrites source files')
  const stored = await (await fetch(endpoint + '/changes', { headers })).json()
  assert.deepEqual(stored.new, refreshed.new)
  assert.deepEqual(stored.skipped, [])
  assert.equal(stored.scannedAt, refreshed.scannedAt)

  // A file the scan skips is explained by the same endpoint, so "no changes" is never silently clean.
  const blocked = join(sourceDir, '超大扫描件.pdf')
  await writeFile(blocked, Buffer.alloc(64, 1)); await truncate(blocked, 257 * 1024 * 1024)
  const withSkip = await (await fetch(endpoint + '/changes', { method: 'POST', headers, body: '{}' })).json()
  assert.equal(withSkip.new.length, 1, 'the earlier new file is still unprocessed')
  assert.equal(withSkip.skipped.length, 1)
  assert.equal(withSkip.skipped[0].name, '超大扫描件.pdf')
  assert.match(withSkip.skipped[0].reason, /256 MB/)
  const skippedStored = await (await fetch(endpoint + '/changes', { headers })).json()
  assert.deepEqual(skippedStored.skipped, withSkip.skipped)
})
