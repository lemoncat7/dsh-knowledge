import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from '../atomic-file.js'
import { noteFingerprint } from './sync-protocol.js'
import { isEditableNoteNode, type NoteFileUpload, type NoteNode, type NoteNodeKind } from './domain.js'
import {
  MAX_NOTE_BYTES,
  MAX_NOTE_NAME_LENGTH,
  conflict,
  enqueueContentMutation,
  isNodeError,
  normalizeMediaType,
  normalizeNoteName,
  normalizeParentId,
  notFound,
  objectPath,
  parentKey,
  sizeError,
  versionDirectory,
  versionPath,
  type NoteStoreHost,
  type NoteStoreTreeAccess,
} from './note-store-internal.js'

export interface NoteStoreMutationDeps extends NoteStoreHost { readonly tree: NoteStoreTreeAccess }

/** Node-tree mutations: creation, rename/move/relocate, copy and delete. */
export class NoteStoreMutations {
  constructor(private readonly deps: NoteStoreMutationDeps) {}

  async createFolder(name: string, parentId: string | null = null): Promise<NoteNode> {
    return this.createNode('folder', name, parentId, null, Buffer.alloc(0))
  }

  async createDocument(name: string, parentId: string | null = null, content = ''): Promise<NoteNode> {
    const normalized = name.trim().toLocaleLowerCase().endsWith('.md') ? name : `${name}.md`
    return this.createNode('document', normalized, parentId, 'text/markdown', Buffer.from(content, 'utf8'))
  }

  async upload(upload: NoteFileUpload): Promise<NoteNode> {
    return this.createNode('file', upload.name, upload.parentId ?? null, upload.mediaType, Buffer.from(upload.content))
  }

  relocate(id: string, name: string, parentId: string | null, expected: string): Promise<NoteNode> {
    return enqueueContentMutation(this.deps.contentMutationTails, id, async () => {
      const node = this.deps.tree.requireNode(id)
      if (noteFingerprint(node) !== expected) throw conflict('笔记已变化，未应用外部路径操作')
      const normalized = normalizeNoteName(name), parent = normalizeParentId(parentId)
      if (parent !== null) {
        this.deps.tree.assertFolder(parent)
        if (parent === id || (node.kind === 'folder' && this.deps.tree.isDescendant(parent, id))) throw conflict('目录不能移动到自身内部')
      }
      this.deps.tree.assertNameAvailable(parent, normalized, id)
      const updatedAt = new Date().toISOString()
      this.deps.db.prepare('UPDATE note_nodes SET name=?, parent_id=?, parent_key=?, updated_at=? WHERE id=?')
        .run(normalized, parent, parentKey(parent), updatedAt, id)
      const result = { ...node, name: normalized, parentId: parent, updatedAt }
      return { ...result, editable: isEditableNoteNode(result) }
    })
  }

  rename(id: string, name: string): NoteNode {
    const node = this.deps.tree.requireNode(id)
    const normalized = normalizeNoteName(name)
    this.deps.tree.assertNameAvailable(node.parentId, normalized, id)
    const updatedAt = new Date().toISOString()
    this.deps.db.exec('BEGIN IMMEDIATE')
    try {
      this.deps.db.prepare('UPDATE note_nodes SET name=?, updated_at=? WHERE id=?').run(normalized, updatedAt, id)
      this.deps.db.prepare('UPDATE note_versions SET name=? WHERE note_id=? AND version=?').run(normalized, id, node.version)
      this.deps.db.exec('COMMIT')
    } catch (error) {
      this.deps.db.exec('ROLLBACK')
      throw error
    }
    const renamed = { ...node, name: normalized, updatedAt }
    return { ...renamed, editable: isEditableNoteNode(renamed) }
  }

  move(id: string, parentId: string | null): NoteNode {
    const node = this.deps.tree.requireNode(id)
    const normalizedParent = normalizeParentId(parentId)
    if (normalizedParent !== null) {
      this.deps.tree.assertFolder(normalizedParent)
      if (normalizedParent === id || (node.kind === 'folder' && this.deps.tree.isDescendant(normalizedParent, id))) {
        throw conflict('a folder cannot be moved into itself or one of its descendants')
      }
    }
    this.deps.tree.assertNameAvailable(normalizedParent, node.name, id)
    const updatedAt = new Date().toISOString()
    this.deps.db.prepare('UPDATE note_nodes SET parent_id=?, parent_key=?, updated_at=? WHERE id=?')
      .run(normalizedParent, parentKey(normalizedParent), updatedAt, id)
    return { ...node, parentId: normalizedParent, updatedAt }
  }

  async copy(id: string, parentId?: string | null, requestedName?: string): Promise<NoteNode> {
    const source = this.deps.tree.requireNode(id)
    const targetParent = parentId === undefined ? source.parentId : normalizeParentId(parentId)
    if (targetParent !== null) this.deps.tree.assertFolder(targetParent)
    const targetName = requestedName === undefined
      ? this.availableCopyName(targetParent, source.name)
      : normalizeNoteName(requestedName)
    this.deps.tree.assertNameAvailable(targetParent, targetName)
    const created: NoteNode[] = []
    try {
      return await this.copyNode(source, targetParent, targetName, created)
    } catch (error) {
      if (created[0] !== undefined) await this.delete(created[0].id).catch(() => {})
      throw error
    }
  }

  async delete(id: string): Promise<void> {
    const nodes = this.deps.tree.subtree(id)
    const files = nodes.filter(node => node.kind !== 'folder')
    const retired: Array<{ target: string; temporary: string }> = []
    try {
      for (const node of files) {
        const retirementTargets: Array<[string, string]> = [
          [objectPath(this.deps.objectsPath, node.id), join(this.deps.objectsPath, `.${node.id}.${randomUUID()}.deleted`)],
          [versionDirectory(this.deps.versionsPath, node.id), join(this.deps.versionsPath, `.${node.id}.${randomUUID()}.deleted`)],
        ]
        for (const [target, temporary] of retirementTargets) {
          try {
            await rename(target, temporary)
            retired.push({ target, temporary })
          } catch (error) {
            if (!isNodeError(error, 'ENOENT')) throw error
          }
        }
      }
      this.deps.db.exec('BEGIN IMMEDIATE')
      try {
        this.deps.db.prepare(`
          WITH RECURSIVE descendants(id) AS (
            SELECT id FROM note_nodes WHERE id=?
            UNION ALL
            SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
          )
          DELETE FROM note_nodes WHERE id IN (SELECT id FROM descendants)
        `).run(id)
        this.deps.db.exec('COMMIT')
      } catch (error) {
        this.deps.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      for (const item of retired.reverse()) await rename(item.temporary, item.target).catch(() => {})
      throw error
    }
    for (const item of retired) await rm(item.temporary, { recursive: true, force: true })
  }

  private async createNode(kind: NoteNodeKind, name: string, parentId: string | null, mediaType: string | null, content: Buffer): Promise<NoteNode> {
    this.deps.assertOpen()
    const db = this.deps.db
    const normalizedName = normalizeNoteName(name)
    const normalizedParent = normalizeParentId(parentId)
    if (normalizedParent !== null) this.deps.tree.assertFolder(normalizedParent)
    this.deps.tree.assertNameAvailable(normalizedParent, normalizedName)
    if (content.byteLength > MAX_NOTE_BYTES) throw sizeError('note file exceeds the 64 MiB limit')
    const id = `note_${randomUUID().replaceAll('-', '')}`
    const timestamp = new Date().toISOString()
    const normalizedMediaType = kind === 'folder' ? null : normalizeMediaType(mediaType ?? 'application/octet-stream')
    const sha256 = kind === 'folder' ? null : createHash('sha256').update(content).digest('hex')
    const versioned = kind !== 'folder' && isEditableNoteNode({ kind, name: normalizedName, mediaType: normalizedMediaType })
    if (kind !== 'folder') {
      await atomicWriteFile(objectPath(this.deps.objectsPath, id), content, { mode: 0o600, replace: false })
      if (versioned) {
        mkdirSync(versionDirectory(this.deps.versionsPath, id), { recursive: true, mode: 0o700 })
        try {
          await atomicWriteFile(versionPath(this.deps.versionsPath, id, 1), content, { mode: 0o600, replace: false })
        } catch (error) {
          await rm(objectPath(this.deps.objectsPath, id), { force: true }).catch(() => {})
          await rm(versionDirectory(this.deps.versionsPath, id), { recursive: true, force: true }).catch(() => {})
          throw error
        }
      }
    }
    try {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare(`
          INSERT INTO note_nodes(id,parent_id,parent_key,kind,name,media_type,size,sha256,version,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `).run(id, normalizedParent, parentKey(normalizedParent), kind, normalizedName, normalizedMediaType, content.byteLength, sha256, 1, timestamp, timestamp)
        if (versioned) {
          db.prepare(`
            INSERT INTO note_versions(note_id,version,name,media_type,size,sha256,created_at)
            VALUES(?,?,?,?,?,?,?)
          `).run(id, 1, normalizedName, normalizedMediaType, content.byteLength, sha256, timestamp)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      if (kind !== 'folder') await rm(objectPath(this.deps.objectsPath, id), { force: true }).catch(() => {})
      if (versioned) await rm(versionDirectory(this.deps.versionsPath, id), { recursive: true, force: true }).catch(() => {})
      throw error
    }
    const node = { id, parentId: normalizedParent, kind, name: normalizedName, mediaType: normalizedMediaType, size: content.byteLength, sha256, version: 1, createdAt: timestamp, updatedAt: timestamp }
    return { ...node, editable: isEditableNoteNode(node) }
  }

  private async copyNode(source: NoteNode, parentId: string | null, name: string, created: NoteNode[]): Promise<NoteNode> {
    if (source.kind === 'folder') {
      const folder = await this.createFolder(name, parentId)
      created.push(folder)
      for (const child of this.deps.tree.children(source.id)) {
        await this.copyNode(child, folder.id, child.name, created)
      }
      return folder
    }
    const { content } = await this.deps.tree.read(source.id)
    const copy = source.kind === 'document'
      ? await this.createNode('document', name, parentId, source.mediaType, content)
      : await this.createNode('file', name, parentId, source.mediaType, content)
    created.push(copy)
    return copy
  }

  private availableCopyName(parentId: string | null, original: string): string {
    const dot = original.lastIndexOf('.')
    const hasExtension = dot > 0
    const stem = hasExtension ? original.slice(0, dot) : original
    const extension = hasExtension ? original.slice(dot) : ''
    for (let index = 1; index < 10_000; index += 1) {
      const suffix = index === 1 ? ' 副本' : ` 副本 ${index}`
      const availableStemLength = Math.max(1, MAX_NOTE_NAME_LENGTH - suffix.length - extension.length)
      const candidate = normalizeNoteName(`${stem.slice(0, availableStemLength)}${suffix}${extension}`)
      if (!this.deps.tree.nameExists(parentId, candidate)) return candidate
    }
    throw conflict('could not allocate a copy name')
  }
}
