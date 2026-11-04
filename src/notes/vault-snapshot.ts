import { constants } from 'node:fs'
import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hash } from './sync-protocol.js'
export interface VaultEntry { path: string; directory: boolean; identity: string; signature: string; digest: string | null }
export async function vaultIdentity(path: string) {
  const s = await lstat(path, { bigint: true })
  if (s.isSymbolicLink()) throw Error('工作区路径不能是符号链接')
  return { stat: s, identity: `${s.dev}:${s.ino}:${s.birthtimeNs}` }
}
export async function readVaultBytes(path: string) {
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await f.stat({ bigint: true })
    if (!before.isFile() || before.size > 64n * 1024n * 1024n) throw Error('工作区文件不是普通文件或超过 64 MiB')
    const bytes = await f.readFile(), after = await f.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw Error('文件正在写入，等待下一轮同步')
    return bytes
  } finally { await f.close() }
}
/** A failed/incomplete traversal must never be used to infer deletions. */
export async function snapshotVault(root: string, previous = new Map<string, VaultEntry>()): Promise<Map<string, VaultEntry>> {
  const result = new Map<string, VaultEntry>()
  const walk = async (folder: string, depth: number) => {
    if (depth > 24) throw Error('工作区目录超过 24 层，已暂停同步')
    const names = await readdir(join(root, folder), { withFileTypes: true })
    for (const entry of names) {
      if (entry.name.startsWith('.')) continue
      const path = join(folder, entry.name)
      if (result.size >= 10000) throw Error('工作区超过 10000 个文件，已暂停同步')
      const { stat, identity } = await vaultIdentity(join(root, path))
      if (!stat.isDirectory() && !stat.isFile()) throw Error('工作区包含不支持的文件类型')
      const signature = `${identity}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
      const cached = previous.get(path)
      result.set(path, { path, directory: stat.isDirectory(), identity, signature,
        digest: stat.isDirectory() ? null : cached?.signature === signature ? cached.digest : hash(await readVaultBytes(join(root, path))) })
      if (stat.isDirectory()) await walk(path, depth + 1)
    }
  }
  await walk('', 0)
  return result
}
