import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PythonCandidate {
  path: string
  version: string | undefined
  modules: Record<string, boolean>
  missing: string[]
  ok: boolean
}

const MODULE_IMPORTS: Record<string, string> = { docx: 'python-docx', pptx: 'python-pptx', openpyxl: 'openpyxl', pypdf: 'pypdf', xlrd: 'xlrd' }

function probe(executable: string): Promise<{ version?: string; modules: Record<string, boolean> }> {
  const probeScript = [
    'import json,sys',
    'mods={}',
    ...Object.keys(MODULE_IMPORTS).map(name => `try:\n import ${name}\n mods['${name}']=True\nexcept Exception:\n mods['${name}']=False`),
    'print(json.dumps({"version":sys.version.split()[0],"modules":mods}))',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-c', probeScript], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })
    let out = ''
    child.stdout?.on('data', chunk => { if (out.length < 8192) out += chunk.toString() })
    child.once('error', reject)
    child.once('close', code => {
      if (code !== 0) { reject(new Error(`python probe failed (${code})`)); return }
      try { resolve(JSON.parse(out.trim())) } catch (error) { reject(error) }
    })
  })
}

/** Best-effort discovery; the operator can always type a path instead. */
export async function detectPython(): Promise<PythonCandidate[]> {
  const home = homedir()
  const seeds = new Set<string>()
  if (process.env.DSH_PYTHON) seeds.add(process.env.DSH_PYTHON)
  const runtimeRoot = join(home, '.dsh', 'dsh-runtimes')
  seeds.add(join(runtimeRoot, 'dsh-primary-runtime', 'dependencies', 'python', 'python.exe'))
  const pathDirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
  for (const dir of pathDirs) {
    for (const name of process.platform === 'win32' ? ['python.exe', 'python3.exe'] : ['python3', 'python']) seeds.add(join(dir, name))
  }
  for (const dir of process.platform === 'win32'
    ? [`${process.env.LOCALAPPDATA ?? ''}\\Programs\\Python`, 'C:\\Python312', 'C:\\Python311', 'C:\\Python310']
    : ['/usr/bin', '/usr/local/bin']) {
    if (!dir) continue
    try {
      const { readdirSync } = await import('node:fs')
      for (const entry of readdirSync(dir)) if (/^python(\d|\.|$)/i.test(entry) && !entry.endsWith('.exe')) seeds.add(join(dir, entry))
      for (const entry of readdirSync(dir)) if (/^Python3\d+$/i.test(entry)) seeds.add(join(dir, entry, 'python.exe'))
    } catch { /* optional location */ }
  }
  const results: PythonCandidate[] = []
  for (const candidate of seeds) {
    if (!candidate || !existsSync(candidate)) continue
    if (results.some(item => item.path.toLowerCase() === candidate.toLowerCase())) continue
    try {
      const { version, modules } = await probe(candidate)
      const missing = Object.entries(modules).filter(([, present]) => !present).map(([name]) => MODULE_IMPORTS[name] ?? name)
      results.push({ path: candidate, version, modules, missing, ok: missing.length === 0 })
    } catch { /* not a usable interpreter */ }
    if (results.length >= 8) break
  }
  // Fully capable interpreters first, then the newest version of the rest.
  results.sort((a, b) => Number(b.ok) - Number(a.ok) || String(b.version ?? '').localeCompare(String(a.version ?? ''), 'en', { numeric: true }))
  return results
}

export function installHint(missing: string[]): string {
  return missing.length ? `缺少依赖：${missing.join('、')}。可在该 Python 中运行：python -m pip install ${missing.join(' ')}` : ''
}

/** Installs only the missing parser packages into the selected interpreter. */
export async function installModules(executable: string, modules: string[]): Promise<{ ok: boolean; output: string }> {
  if (!modules.length) return { ok: true, output: '依赖已齐全，无需安装。' }
  if (!existsSync(executable)) throw new Error('PYTHON_NOT_FOUND：解释器不存在')
  const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', ...modules]
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 })
    let output = ''
    const collect = (chunk: Buffer) => { if (output.length < 20_000) output += chunk.toString() }
    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)
    child.once('error', error => reject(new Error(`PYTHON_INSTALL_FAILED：${error.message}`)))
    child.once('close', code => resolve({ ok: code === 0, output: output.slice(-4000) }))
  })
}
