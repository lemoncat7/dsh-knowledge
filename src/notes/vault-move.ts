import { mkdir, rename, link, lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { vaultIdentity } from './vault-snapshot.js'
export interface VaultMove { from: string; to: string; stage: string; identity: string; directory: boolean; name: string; parentId: string | null; reservation?: string }
async function identity(path: string) {
  try { return (await vaultIdentity(path)).identity } catch(e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
}
/** Durable staging is retained. Never replace a destination containing another file. */
export async function moveVaultEntry(move: VaultMove, checkpoint: () => Promise<void> = async () => {}): Promise<void> {
  if (await identity(move.to) === move.identity) return // replay after installation
  const targetIdentity = await identity(move.to)
  const reserved = move.directory && move.reservation !== undefined && targetIdentity === move.reservation
  if (targetIdentity !== null && !reserved) throw Error('目标路径已存在，未覆盖：' + move.to)
  if (await identity(move.stage) === null) {
    if (await identity(move.from) !== move.identity) throw Error('原路径身份已变化，已暂停移动')
    await mkdir(dirname(move.stage), {recursive: true, mode: 0o700})
    if ((await lstat(dirname(move.stage))).isSymbolicLink()) throw Error('移动暂存目录不能是符号链接')
    await rename(move.from, move.stage)
  }
  if (await identity(move.stage) !== move.identity) throw Error('暂存文件身份不符，保留原内容等待处理')
  await mkdir(dirname(move.to), {recursive: true, mode: 0o700})
  if (move.directory) {
    // Reserve our own empty destination. A concurrent nonempty destination causes
    // rename to fail, rather than merging or replacing its files.
    if (!reserved) {
      await mkdir(move.to, {mode: 0o700})
      move.reservation = (await vaultIdentity(move.to)).identity
      await checkpoint()
    }
    try { await rename(move.stage, move.to) }
    catch(e) {
      // Keep staging intact; the reservation can be removed only if still empty.
      const {rmdir} = await import('node:fs/promises')
      if (await identity(move.to) === move.reservation) await rmdir(move.to).catch(()=>{})
      throw e
    }
  } else await link(move.stage, move.to) // exclusive; original inode survives at stage
}
