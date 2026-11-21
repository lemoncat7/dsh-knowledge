import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

export interface BrowseEntry { name: string; path: string }
export interface BrowseResult { path: string; parent: string | null; entries: BrowseEntry[]; shortcuts: BrowseEntry[]; truncated: boolean }
const MAX_ENTRIES = 500

async function shortcuts(): Promise<BrowseEntry[]> {
  const home = homedir()
  const candidates: BrowseEntry[] = [
    { name: '主目录', path: home },
    ...['Desktop', 'Documents', 'Downloads', '桌面', '文档', '下载'].map(name => ({ name: ({ Desktop: '桌面', Documents: '文档', Downloads: '下载' } as Record<string, string>)[name] ?? name, path: join(home, name) })),
    ...(process.platform === 'win32'
      ? [...'CDEFGHIJKLMNOPQRSTUVWXYZ'].map(letter => ({ name: `${letter}: 盘`, path: `${letter}:\\` }))
      : [{ name: '根目录', path: '/' }]),
  ]
  const existing = await Promise.all(candidates.map(async item => {
    try { return (await stat(item.path)).isDirectory() ? item : undefined } catch { return undefined }
  }))
  return existing.filter((item): item is BrowseEntry => item !== undefined)
}

/** Local read-only listing; invalid/unavailable paths have an explicit visible error. */
export async function browseDirectory(input?: string): Promise<BrowseResult> {
  const target = input && input.trim() ? input.trim() : homedir()
  if (!isAbsolute(target)) throw new Error('BROWSE_PATH_NOT_ABSOLUTE：请提供一个绝对路径')
  const path = resolve(target)
  let dirents
  try { dirents = await readdir(path, { withFileTypes: true }) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new Error(`BROWSE_NOT_FOUND：目录不存在（${path}）`)
    if (code === 'EACCES' || code === 'EPERM') throw new Error(`BROWSE_DENIED：没有权限读取（${path}）`)
    throw error
  }
  const entries = dirents.filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
    .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  const parent = dirname(path)
  return { path, parent: parent === path ? null : parent, entries: entries.slice(0, MAX_ENTRIES), shortcuts: await shortcuts(), truncated: entries.length > MAX_ENTRIES }
}
