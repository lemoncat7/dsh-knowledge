import { isAbsolute, resolve, relative, sep, parse, join } from 'node:path'
import { homedir } from 'node:os'
import { lstat, realpath } from 'node:fs/promises'

function fail(code: string): never { throw Object.assign(new Error(code), { code }) }
const reserved = /^(?:_meta|documents|\.wiki-staging|\.git|node_modules)$/i
export interface WikiLayout { kbId: string; sourceDir: string; workspaceRoot: string; pageDir: string; rawDir: string; metaDir: string }
export function isPathInside(root: string, path: string): boolean {
  const canonical = (s: string) => process.platform === 'win32' ? resolve(s).toLowerCase() : resolve(s)
  const r = relative(canonical(root), canonical(path))
  return r === '' || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r))
}
function overlap(a: string, b: string): boolean { return isPathInside(a, b) || isPathInside(b, a) }
export function resolveWikiLayout(input: { kbId: string; sourceDir: string; workspaceRoot: string; pageDir?: string; rawDir?: string }): WikiLayout {
  for (const p of [input.sourceDir, input.workspaceRoot]) {
    if (!isAbsolute(p) || resolve(p) === parse(resolve(p)).root || resolve(p).toLowerCase() === resolve(homedir()).toLowerCase()) fail('UNSAFE_ROOT')
  }
  const workspaceRoot = resolve(input.workspaceRoot), sourceDir = resolve(input.sourceDir)
  const pageDir = resolve(workspaceRoot, input.pageDir ?? 'wiki'), rawDir = resolve(workspaceRoot, input.rawDir ?? 'raw')
  if (!input.kbId.trim()) fail('INVALID_ARGUMENT')
  for (const p of [workspaceRoot, pageDir, rawDir]) {
    if (p.split(/[\\/]/).some(segment => reserved.test(segment))) fail('RESERVED_PATH')
  }
  if (!isPathInside(workspaceRoot, pageDir) || pageDir === workspaceRoot || overlap(sourceDir, workspaceRoot)
    || overlap(sourceDir, rawDir) || overlap(pageDir, rawDir)) fail('OVERLAP')
  return { kbId: input.kbId, sourceDir, workspaceRoot, pageDir, rawDir, metaDir: join(workspaceRoot, '_meta', 'knowledge') }
}
export function normalizePageRelPath(path: string): string {
  if (!path || path.includes('\\') || path.includes(':') || path.includes('\0') || path.startsWith('/') || path.split('/').some(p => !p || p === '.' || p === '..')) fail('PATH_ESCAPE')
  if (!path.endsWith('.md') || path.split('/').some(p => reserved.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
    || /^(index|log|schema)\.md$/i.test(path)) fail('RESERVED_PATH')
  return path
}
export function pageTargetPath(layout: WikiLayout, relPath: string): string { return join(layout.pageDir, normalizePageRelPath(relPath)) }
export async function assertPageTargetSafe(layout: WikiLayout, relPath: string): Promise<string> {
  const target = pageTargetPath(layout, relPath)
  const actualRoot = await realpath(layout.pageDir)
  // Inspect every existing ancestor and target; missing descendants are safe only below verified parents.
  let current = layout.pageDir
  for (const part of normalizePageRelPath(relPath).split('/')) {
    current = join(current, part)
    try {
      await lstat(current)
      const actual = await realpath(current)
      if (!isPathInside(actualRoot, actual)) fail('PATH_ESCAPE')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
      throw error
    }
  }
  return target
}
