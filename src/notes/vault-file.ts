import { open, mkdir, rename, link, unlink, lstat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { hash } from './sync-protocol.js'

/**
 * External editors do not honor application locks. Move the previous inode to
 * history, then install with an exclusive link instead of rename-overwriting.
 * A concurrent editor's new file wins; an open old inode remains in history.
 */
export async function installVaultFile(target: string, bytes: Uint8Array, expectedHash: string | null): Promise<boolean> {
  const folder = dirname(target), id = randomUUID(), temporary = join(folder, `.dsh-${id}.tmp`)
  const name = basename(target)
  const archiveName = `${Array.from(name).slice(0, 12).join('')}.${hash(name).slice(0, 12)}.${id}`
  const archiveFolder = join(folder, '.dsh-history'), archived = join(archiveFolder, archiveName)
  let retired = false
  try {
    const prepared = await open(temporary, 'wx', 0o600)
    try { await prepared.writeFile(bytes); await prepared.sync() } finally { await prepared.close() }
    if (expectedHash !== null) {
      await mkdir(archiveFolder, { recursive: true, mode: 0o700 })
      if ((await lstat(archiveFolder)).isSymbolicLink()) throw Error('文件历史目录不能是符号链接')
      await rename(target, archived)
      retired = true
      const previous = await open(archived, constants.O_RDONLY | constants.O_NOFOLLOW)
      let current: Buffer
      try { current = await previous.readFile() } finally { await previous.close() }
      if (hash(current) !== expectedHash) return false
    }
    try { await link(temporary, target) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false; throw error }
    if (process.platform !== 'win32') {
      const dir = await open(folder, 'r')
      try { await dir.sync() } finally { await dir.close() }
    }
    return true
  } finally {
    // Never overwrite a file created by an editor while the old inode was retired.
    try {
      if (retired) await link(archived, target).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error })
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }
}
