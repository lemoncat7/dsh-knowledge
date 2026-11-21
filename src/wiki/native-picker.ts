import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface NativePickResult { path: string | null }

/** ASCII JSON on the pipe: independent of Console.OutputEncoding / ANSI code page. */
export const NATIVE_PICKER_RESULT_SCRIPT = `
if ($null -eq $selectedPath) {
  [Console]::Out.Write('{"cancelled":true}')
} else {
  $encodedPath = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([string]$selectedPath))
  [Console]::Out.Write('{"pathUtf16":"' + $encodedPath + '"}')
}
`

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择目录'
$dialog.ShowNewFolderButton = $true
if ($env:WIKI_PICK_INITIAL -and (Test-Path -LiteralPath $env:WIKI_PICK_INITIAL -PathType Container)) {
  $dialog.SelectedPath = $env:WIKI_PICK_INITIAL
}
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = 'Minimized'
$selectedPath = $null
try {
  $owner.Show()
  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
    $selectedPath = $dialog.SelectedPath
  }
} finally {
  $dialog.Dispose()
  $owner.Close()
  $owner.Dispose()
}
${NATIVE_PICKER_RESULT_SCRIPT}`

export function decodeNativePickerResult(output: Uint8Array): NativePickResult {
  const invalid = () => new Error('PICK_RESULT_INVALID：目录选择结果无效，请重新选择')
  let result: unknown
  try { result = JSON.parse(Buffer.from(output).toString('ascii').trim()) } catch { throw invalid() }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw invalid()
  const value = result as Record<string, unknown>
  if (value.cancelled === true && value.pathUtf16 === undefined) return { path: null }
  if (typeof value.pathUtf16 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.pathUtf16)) throw invalid()
  const bytes = Buffer.from(value.pathUtf16, 'base64')
  if (!bytes.length || bytes.length % 2 || bytes.toString('base64') !== value.pathUtf16) throw invalid()
  const path = bytes.toString('utf16le')
  if (!(/^[a-zA-Z]:[\\/]/.test(path) || path.startsWith('\\\\')) || /[\u0000\r\n\ufffd]/u.test(path) || !Buffer.from(path, 'utf16le').equals(bytes)) throw invalid()
  return { path }
}

function powershell(): string {
  const executable = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  return existsSync(executable) ? executable : 'powershell.exe'
}

/** Opens a native chooser. The API provides timeout/caller cancellation. */
export function pickDirectoryNative(initial: string | undefined, signal: AbortSignal): Promise<NativePickResult> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    // EncodedCommand is UTF-16LE; no shell quoting or locale-dependent script decoding.
    const child = spawn(powershell(), ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(initial ? { WIKI_PICK_INITIAL: initial } : {}) },
    })
    const output: Buffer[] = [], errors: Buffer[] = []
    let size = 0
    child.stdout?.on('data', (bytes: Buffer) => {
      size += bytes.length
      if (size > 32768) { child.kill(); reject(new Error('PICK_RESULT_INVALID：目录选择结果过大')); return }
      output.push(bytes)
    })
    child.stderr?.on('data', (bytes: Buffer) => { if (errors.reduce((n, b) => n + b.length, 0) < 4096) errors.push(bytes) })
    const abort = () => { child.kill(); reject(new Error('PICK_CANCELLED：选择框已关闭')) }
    signal.addEventListener('abort', abort, { once: true })
    child.once('error', error => { signal.removeEventListener('abort', abort); reject(new Error(`PICK_UNAVAILABLE：${error.message}`)) })
    child.once('close', code => {
      signal.removeEventListener('abort', abort)
      if (code !== 0) { reject(new Error(`PICK_FAILED：系统选择框未完成（${code}），可改用站内浏览`)); return }
      try { resolve(decodeNativePickerResult(Buffer.concat(output))) } catch (error) { reject(error) }
    })
    if (signal.aborted) abort()
  })
}
