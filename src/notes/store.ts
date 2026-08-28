import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { atomicWriteFile } from '../atomic-file.js'
import {
  isEditableNoteNode,
  isNoteId,
  type NoteFileUpload,
  type NoteListRequest,
  type NoteNode,
  type NoteNodeKind,
} from './domain.js'

type SqlRow = Record<string, unknown>

const MAX_NOTE_BYTES = 64 * 1024 * 1024
const MAX_NOTE_NAME_LENGTH = 255

export class NoteStore {
  private readonly db: DatabaseSync
  private readonly objectsPath: string
  private closed = false

  constructor(private readonly rootPath: string, private readonly removeOnClose = false) {
    this.objectsPath = join(rootPath, 'objects')
    mkdirSync(this.objectsPath, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(rootPath, 'notes.sqlite'))
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  list(request: NoteListRequest = {}): NoteNode[] {
    this.assertOpen()
    const query = request.query?.trim() ?? ''
    const limit = normalizeLimit(request.limit)
    if (query.length > 0) {
      return (this.db.prepare(`
        SELECT ${NOTE_COLUMNS}
        FROM note_nodes
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
        LIMIT ?
      `).all(`%${escapeLike(query)}%`, limit) as SqlRow[]).map(mapNoteNode)
    }
    const parentId = normalizeParentId(request.parentId)
    if (parentId !== null) this.assertFolder(parentId)
    return (this.db.prepare(`
      SELECT ${NOTE_COLUMNS}
      FROM note_nodes
      WHERE parent_key = ?
      ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
      LIMIT ?
    `).all(parentKey(parentId), limit) as SqlRow[]).map(mapNoteNode)
  }

  get(id: string): NoteNode | undefined {
    this.assertOpen()
    assertNoteId(id)
    const row = this.db.prepare(`SELECT ${NOTE_COLUMNS} FROM note_nodes WHERE id=?`).get(id) as SqlRow | undefined
    return row === undefined ? undefined : mapNoteNode(row)
  }

  subtree(id: string): NoteNode[] {
    this.assertOpen()
    assertNoteId(id)
    const rows = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM note_nodes WHERE id=?
        UNION ALL
        SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
      )
      SELECT ${NOTE_COLUMNS} FROM note_nodes WHERE id IN (SELECT id FROM descendants)
    `).all(id) as SqlRow[]
    if (rows.length === 0) throw notFound(`note node "${id}" was not found`)
    return rows.map(mapNoteNode)
  }

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

  async read(id: string): Promise<{ node: NoteNode; content: Buffer }> {
    const node = this.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    if (node.kind === 'folder') throw inputError('folders do not have file content')
    try {
      const content = await readFile(this.objectPath(id))
      if (content.byteLength !== node.size) throw new Error(`note node "${id}" has an invalid stored size`)
      return { node, content }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw notFound(`note content "${id}" was not found`)
      throw error
    }
  }

  async updateContent(id: string, content: Uint8Array): Promise<NoteNode> {
    const node = this.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    if (!isEditableNoteNode(node)) throw inputError('only text-based note files can be edited')
    if (content.byteLength > MAX_NOTE_BYTES) throw sizeError('note content exceeds the 64 MiB limit')
    const target = this.objectPath(id)
    await atomicWriteFile(target, content, { mode: 0o600, replace: true })
    const updatedAt = new Date().toISOString()
    const sha256 = createHash('sha256').update(content).digest('hex')
    this.db.prepare('UPDATE note_nodes SET size=?, sha256=?, updated_at=? WHERE id=?')
      .run(content.byteLength, sha256, updatedAt, id)
    return { ...node, size: content.byteLength, sha256, updatedAt }
  }

  rename(id: string, name: string): NoteNode {
    const node = this.requireNode(id)
    const normalized = normalizeNoteName(name)
    this.assertNameAvailable(node.parentId, normalized, id)
    const updatedAt = new Date().toISOString()
    this.db.prepare('UPDATE note_nodes SET name=?, updated_at=? WHERE id=?').run(normalized, updatedAt, id)
    const renamed = { ...node, name: normalized, updatedAt }
    return { ...renamed, editable: isEditableNoteNode(renamed) }
  }

  move(id: string, parentId: string | null): NoteNode {
    const node = this.requireNode(id)
    const normalizedParent = normalizeParentId(parentId)
    if (normalizedParent !== null) {
      this.assertFolder(normalizedParent)
      if (normalizedParent === id || (node.kind === 'folder' && this.isDescendant(normalizedParent, id))) {
        throw conflict('a folder cannot be moved into itself or one of its descendants')
      }
    }
    this.assertNameAvailable(normalizedParent, node.name, id)
    const updatedAt = new Date().toISOString()
    this.db.prepare('UPDATE note_nodes SET parent_id=?, parent_key=?, updated_at=? WHERE id=?')
      .run(normalizedParent, parentKey(normalizedParent), updatedAt, id)
    return { ...node, parentId: normalizedParent, updatedAt }
  }

  async copy(id: string, parentId?: string | null, requestedName?: string): Promise<NoteNode> {
    const source = this.requireNode(id)
    const targetParent = parentId === undefined ? source.parentId : normalizeParentId(parentId)
    if (targetParent !== null) this.assertFolder(targetParent)
    const targetName = requestedName === undefined
      ? this.availableCopyName(targetParent, source.name)
      : normalizeNoteName(requestedName)
    this.assertNameAvailable(targetParent, targetName)
    const created: NoteNode[] = []
    try {
      return await this.copyNode(source, targetParent, targetName, created)
    } catch (error) {
      if (created[0] !== undefined) await this.delete(created[0].id).catch(() => {})
      throw error
    }
  }

  async delete(id: string): Promise<void> {
    const nodes = this.subtree(id)
    const files = nodes.filter(node => node.kind !== 'folder')
    const retired: Array<{ target: string; temporary: string }> = []
    try {
      for (const node of files) {
        const target = this.objectPath(node.id)
        const temporary = join(this.objectsPath, `.${node.id}.${randomUUID()}.deleted`)
        try {
          await rename(target, temporary)
          retired.push({ target, temporary })
        } catch (error) {
          if (!isNodeError(error, 'ENOENT')) throw error
        }
      }
      this.db.exec('BEGIN IMMEDIATE')
      try {
        this.db.prepare(`
          WITH RECURSIVE descendants(id) AS (
            SELECT id FROM note_nodes WHERE id=?
            UNION ALL
            SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
          )
          DELETE FROM note_nodes WHERE id IN (SELECT id FROM descendants)
        `).run(id)
        this.db.exec('COMMIT')
      } catch (error) {
        this.db.exec('ROLLBACK')
        throw error
      }
    } catch (error) {
      for (const item of retired.reverse()) await rename(item.temporary, item.target).catch(() => {})
      throw error
    }
    for (const item of retired) await rm(item.temporary, { force: true })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
    if (this.removeOnClose) await rm(this.rootPath, { recursive: true, force: true })
  }

  private async createNode(kind: NoteNodeKind, name: string, parentId: string | null, mediaType: string | null, content: Buffer): Promise<NoteNode> {
    this.assertOpen()
    const normalizedName = normalizeNoteName(name)
    const normalizedParent = normalizeParentId(parentId)
    if (normalizedParent !== null) this.assertFolder(normalizedParent)
    this.assertNameAvailable(normalizedParent, normalizedName)
    if (content.byteLength > MAX_NOTE_BYTES) throw sizeError('note file exceeds the 64 MiB limit')
    const id = `note_${randomUUID().replaceAll('-', '')}`
    const timestamp = new Date().toISOString()
    const normalizedMediaType = kind === 'folder' ? null : normalizeMediaType(mediaType ?? 'application/octet-stream')
    const sha256 = kind === 'folder' ? null : createHash('sha256').update(content).digest('hex')
    if (kind !== 'folder') await atomicWriteFile(this.objectPath(id), content, { mode: 0o600, replace: false })
    try {
      this.db.prepare(`
        INSERT INTO note_nodes(id,parent_id,parent_key,kind,name,media_type,size,sha256,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)
      `).run(id, normalizedParent, parentKey(normalizedParent), kind, normalizedName, normalizedMediaType, content.byteLength, sha256, timestamp, timestamp)
    } catch (error) {
      if (kind !== 'folder') await rm(this.objectPath(id), { force: true }).catch(() => {})
      throw error
    }
    const node = { id, parentId: normalizedParent, kind, name: normalizedName, mediaType: normalizedMediaType, size: content.byteLength, sha256, createdAt: timestamp, updatedAt: timestamp }
    return { ...node, editable: isEditableNoteNode(node) }
  }

  private async copyNode(source: NoteNode, parentId: string | null, name: string, created: NoteNode[]): Promise<NoteNode> {
    if (source.kind === 'folder') {
      const folder = await this.createFolder(name, parentId)
      created.push(folder)
      for (const child of this.children(source.id)) {
        await this.copyNode(child, folder.id, child.name, created)
      }
      return folder
    }
    const { content } = await this.read(source.id)
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
      if (!this.nameExists(parentId, candidate)) return candidate
    }
    throw conflict('could not allocate a copy name')
  }

  private requireNode(id: string): NoteNode {
    const node = this.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    return node
  }

  private children(parentId: string): NoteNode[] {
    return (this.db.prepare(`
      SELECT ${NOTE_COLUMNS} FROM note_nodes WHERE parent_key=?
      ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
    `).all(parentId) as SqlRow[]).map(mapNoteNode)
  }

  private assertFolder(id: string): void {
    const parent = this.get(id)
    if (parent === undefined) throw notFound(`note folder "${id}" was not found`)
    if (parent.kind !== 'folder') throw inputError('parentId must identify a folder')
  }

  private assertNameAvailable(parentId: string | null, name: string, exceptId?: string): void {
    const row = this.db.prepare(`
      SELECT id FROM note_nodes WHERE parent_key=? AND name=? COLLATE NOCASE
    `).get(parentKey(parentId), name) as SqlRow | undefined
    if (row !== undefined && row.id !== exceptId) throw conflict(`"${name}" already exists in this folder`)
  }

  private nameExists(parentId: string | null, name: string): boolean {
    return this.db.prepare('SELECT 1 FROM note_nodes WHERE parent_key=? AND name=? COLLATE NOCASE')
      .get(parentKey(parentId), name) !== undefined
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    return this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM note_nodes WHERE parent_id=?
        UNION ALL
        SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
      )
      SELECT 1 FROM descendants WHERE id=? LIMIT 1
    `).get(ancestorId, candidateId) !== undefined
  }

  private migrate(): void {
    const version = Number((this.db.prepare('PRAGMA user_version').get() as SqlRow).user_version ?? 0)
    if (version > 1) throw new Error(`note database schema ${version} is newer than this plugin supports`)
    if (version === 0) this.db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE note_nodes (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        parent_key TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('folder','document','file')),
        name TEXT NOT NULL,
        media_type TEXT,
        size INTEGER NOT NULL CHECK(size >= 0),
        sha256 TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX note_sibling_name ON note_nodes(parent_key, name COLLATE NOCASE);
      CREATE INDEX note_parent_order ON note_nodes(parent_key, kind, name COLLATE NOCASE);
      CREATE INDEX note_name ON note_nodes(name COLLATE NOCASE);
      PRAGMA user_version = 1;
      COMMIT;
    `)
  }

  private objectPath(id: string): string {
    assertNoteId(id)
    return join(this.objectsPath, id)
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('note store is closed')
  }
}

const NOTE_COLUMNS = 'id,parent_id,parent_key,kind,name,media_type,size,sha256,created_at,updated_at'

export function normalizeNoteName(value: string): string {
  const name = value.trim().normalize('NFC')
  if (name.length === 0 || name.length > MAX_NOTE_NAME_LENGTH) {
    throw inputError(`note name must contain 1-${MAX_NOTE_NAME_LENGTH} characters`)
  }
  if (name === '.' || name === '..' || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw inputError('note name contains unsupported path characters')
  }
  return name
}

function normalizeMediaType(value: string): string {
  const mediaType = value.trim().toLowerCase() || 'application/octet-stream'
  if (mediaType.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/.test(mediaType)) {
    throw inputError('note media type is invalid')
  }
  return mediaType.split(';', 1)[0] as string
}

function normalizeParentId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null
  assertNoteId(value)
  return value
}

function parentKey(value: string | null): string {
  return value ?? ''
}

function normalizeLimit(value: number | undefined): number {
  return Number.isInteger(value) ? Math.min(500, Math.max(1, value as number)) : 200
}

function mapNoteNode(row: SqlRow): NoteNode {
  const node = {
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    kind: String(row.kind) as NoteNodeKind,
    name: String(row.name),
    mediaType: row.media_type === null ? null : String(row.media_type),
    size: Number(row.size),
    sha256: row.sha256 === null ? null : String(row.sha256),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
  return { ...node, editable: isEditableNoteNode(node) }
}

function assertNoteId(id: string): void {
  if (!isNoteId(id)) throw inputError('note id is invalid')
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

function inputError(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST', status: 400 })
}

function sizeError(message: string): Error {
  return Object.assign(new Error(message), { code: 'PAYLOAD_TOO_LARGE', status: 413 })
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'CONFLICT', status: 409 })
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_FOUND', status: 404 })
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
