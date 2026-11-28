import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { open, readFile, rm } from 'node:fs/promises'
import { atomicWriteFile } from '../atomic-file.js'
import { isEditableNoteNode, type NoteNode, type NoteVersion } from './domain.js'
import {
  MAX_NOTE_BYTES,
  conflict,
  enqueueContentMutation,
  inputError,
  isNodeError,
  mapNoteVersion,
  normalizeVersion,
  notFound,
  objectPath,
  sizeError,
  versionDirectory,
  versionPath,
  type NoteStoreHost,
  type NoteStoreTreeAccess,
  type SqlRow,
} from './note-store-internal.js'

export interface NoteStoreVersionDeps extends NoteStoreHost { readonly tree: NoteStoreTreeAccess }

/** Content preview, version history, snapshots and content edits (the content-mutation lock lives here). */
export class NoteStoreVersions {
  constructor(private readonly deps: NoteStoreVersionDeps) {}

  async readPreview(id: string, maximumBytes: number): Promise<{ node: NoteNode; content: Buffer; truncated: boolean }> {
    const node = this.deps.tree.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    if (node.kind === 'folder') throw inputError('folders do not have file content')
    const limit = Number.isInteger(maximumBytes) ? Math.min(MAX_NOTE_BYTES, Math.max(1, maximumBytes)) : 512 * 1024
    const size = Math.min(node.size, limit)
    const blob = this.deps.db.prepare('SELECT content FROM note_sync_content WHERE note_id=? AND version=?').get(id,node.version) as {content:Uint8Array}|undefined
    if(blob) return {node,content:Buffer.from(blob.content).subarray(0,size),truncated:node.size>size}
    const content = Buffer.alloc(size)
    let file: Awaited<ReturnType<typeof open>> | undefined
    try {
      file = await open(objectPath(this.deps.objectsPath, id), 'r')
      const { bytesRead } = await file.read(content, 0, size, 0)
      if (bytesRead !== size) throw new Error(`note node "${id}" has an invalid stored size`)
      return { node, content, truncated: node.size > size }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw notFound(`note content "${id}" was not found`)
      throw error
    } finally {
      await file?.close().catch(() => {})
    }
  }

  async readSnapshot(id: string): Promise<{ node: NoteNode; content: Buffer }> {
    return enqueueContentMutation(this.deps.contentMutationTails, id, () => this.deps.tree.read(id))
  }

  async updateContent(id: string, content: Uint8Array, expectedVersion?: number, source = '应用修改'): Promise<NoteNode> {
    const bytes = Buffer.from(content)
    return enqueueContentMutation(this.deps.contentMutationTails, id, () => {
      if (expectedVersion !== undefined && this.deps.tree.requireNode(id).version !== normalizeVersion(expectedVersion)) {
        throw conflict('笔记已被修改，请重新读取并合并后保存')
      }
      return this.updateContentNow(id, bytes, source)
    })
  }

  listVersions(id: string, limit = 100): NoteVersion[] {
    this.deps.assertOpen()
    this.deps.tree.requireNode(id)
    const boundedLimit = Number.isInteger(limit) ? Math.min(200, Math.max(1, limit)) : 100
    return (this.deps.db.prepare(`
      SELECT note_id,version,name,media_type,size,sha256,created_at
      FROM note_versions
      WHERE note_id=?
      ORDER BY version DESC
      LIMIT ?
    `).all(id, boundedLimit) as SqlRow[]).map(row => ({...mapNoteVersion(row), ...this.versionSource(id, Number(row.version))}))
  }

  async readVersion(id: string, version: number): Promise<{ node: NoteNode; version: NoteVersion; content: Buffer }> {
    this.deps.assertOpen()
    const node = this.deps.tree.requireNode(id)
    const normalizedVersion = normalizeVersion(version)
    const row = this.deps.db.prepare(`
      SELECT note_id,version,name,media_type,size,sha256,created_at
      FROM note_versions
      WHERE note_id=? AND version=?
    `).get(id, normalizedVersion) as SqlRow | undefined
    if (row === undefined) throw notFound(`note version "${id}@${normalizedVersion}" was not found`)
    const snapshot = {...mapNoteVersion(row), ...this.versionSource(id, normalizedVersion)}
    try {
      const blob = this.deps.db.prepare('SELECT content FROM note_sync_content WHERE note_id=? AND version=?').get(id,normalizedVersion) as {content:Uint8Array}|undefined
      const content = blob ? Buffer.from(blob.content) : await readFile(versionPath(this.deps.versionsPath, id, normalizedVersion))
      if (content.byteLength !== snapshot.size || createHash('sha256').update(content).digest('hex') !== snapshot.sha256) {
        throw new Error(`note version "${id}@${normalizedVersion}" has invalid stored content`)
      }
      return { node, version: snapshot, content }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw notFound(`note version content "${id}@${normalizedVersion}" was not found`)
      throw error
    }
  }

  async restoreVersion(id: string, version: number, expectedVersion?: number): Promise<NoteNode> {
    return enqueueContentMutation(this.deps.contentMutationTails, id, async () => {
      const current = this.deps.tree.requireNode(id)
      if (expectedVersion !== undefined && current.version !== normalizeVersion(expectedVersion)) {
        throw conflict(`note node "${id}" changed after its history was opened`)
      }
      const historical = await this.readVersion(id, version)
      return this.updateContentNow(id, historical.content, '恢复历史')
    })
  }

  private versionSource(id: string, version: number): {source?: string} {
    const row = this.deps.db.prepare('SELECT source FROM note_version_sources WHERE note_id=? AND version=?').get(id, version) as {source: string} | undefined
    return row ?? {}
  }

  private async updateContentNow(id: string, content: Buffer, source = '应用修改'): Promise<NoteNode> {
    const node = this.deps.tree.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    if (!isEditableNoteNode(node)) throw inputError('only text-based note files can be edited')
    if (content.byteLength > MAX_NOTE_BYTES) throw sizeError('note content exceeds the 64 MiB limit')
    const sha256 = createHash('sha256').update(content).digest('hex')
    if (node.sha256 === sha256) return node
    const previous = await this.deps.tree.read(id)
    const version = node.version + 1
    const snapshotPath = versionPath(this.deps.versionsPath, id, version)
    mkdirSync(versionDirectory(this.deps.versionsPath, id), { recursive: true, mode: 0o700 })
    await rm(snapshotPath, { force: true })
    await atomicWriteFile(snapshotPath, content, { mode: 0o600, replace: false })
    const target = objectPath(this.deps.objectsPath, id)
    try {
      await atomicWriteFile(target, content, { mode: 0o600, replace: true })
      const updatedAt = new Date().toISOString()
      this.deps.db.exec('BEGIN IMMEDIATE')
      try {
        this.deps.db.prepare(`
          INSERT INTO note_versions(note_id,version,name,media_type,size,sha256,created_at)
          VALUES(?,?,?,?,?,?,?)
        `).run(id, version, node.name, node.mediaType, content.byteLength, sha256, updatedAt)
        this.deps.db.prepare('INSERT OR REPLACE INTO note_version_sources VALUES(?,?,?)').run(id, version, source)
        const result = this.deps.db.prepare('UPDATE note_nodes SET size=?, sha256=?, version=?, updated_at=? WHERE id=? AND version=?')
          .run(content.byteLength, sha256, version, updatedAt, id, node.version)
        if (result.changes !== 1) throw conflict(`note node "${id}" changed while it was being saved`)
        this.deps.db.exec('COMMIT')
      } catch (error) {
        this.deps.db.exec('ROLLBACK')
        throw error
      }
      return { ...node, size: content.byteLength, sha256, version, updatedAt }
    } catch (error) {
      await atomicWriteFile(target, previous.content, { mode: 0o600, replace: true }).catch(() => {})
      await rm(snapshotPath, { force: true }).catch(() => {})
      throw error
    }
  }
}
