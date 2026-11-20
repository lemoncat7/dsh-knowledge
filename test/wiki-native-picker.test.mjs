import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import * as picker from '../lib/wiki/native-picker.js'

const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

test('native chooser transports Chinese, spaces and emoji independently of Windows output code page', { skip: process.platform !== 'win32' }, () => {
  assert.equal(typeof picker.NATIVE_PICKER_RESULT_SCRIPT, 'string', 'production result emitter must be available')
  assert.equal(typeof picker.decodeNativePickerResult, 'function')
  const selected = 'E:\\文档\\示例知识库\\测试 目录😀'
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    '[Console]::OutputEncoding = [System.Text.Encoding]::GetEncoding(936); $selectedPath = $env:WIKI_TEST_SELECTED; ' + picker.NATIVE_PICKER_RESULT_SCRIPT],
    { env: { ...process.env, WIKI_TEST_SELECTED: selected } })
  assert.equal(result.status, 0, result.stderr.toString())
  assert.ok([...result.stdout].every(byte => byte < 128), 'the wire representation must be ASCII even under GBK')
  assert.deepEqual(picker.decodeNativePickerResult(result.stdout), { path: selected })
})

test('native chooser cancellation and invalid wire data never return a corrupted path', () => {
  assert.equal(typeof picker.decodeNativePickerResult, 'function')
  assert.deepEqual(picker.decodeNativePickerResult(Buffer.from('{"cancelled":true}')), { path: null })
  for (const value of ['', '{}', '{"pathUtf16":"not base64!"}', '{"pathUtf16":"LwA="}']) {
    assert.throws(() => picker.decodeNativePickerResult(Buffer.from(value)), /PICK_RESULT_INVALID/)
  }
})
