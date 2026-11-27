import { readFile } from 'node:fs/promises'
import { decodePageCursor, encodePageCursor } from '../page-cursor.js'
import type { NoteListRequest, NoteNode } from './domain.js'
import {
  NOTE_COLUMNS,
  assertNoteId,
  conflict,
  escapeLike,
  inputError,
  isNodeError,
  mapNoteNode,
  normalizeLimit,
  normalizeParentId,
  notFound,
  objectPath,
  parentKey,
  type SqlRow,
  type NoteStoreHost,
  type NoteStoreTreeAccess,
} from './note-store-internal.js'

/** Node-tree reads plus the tree primitives the other note-store submodules share. */
export class NoteStoreCrud {
  constructor(private readonly host: NoteStoreHost) {}

  list(request: NoteListRequest = {}): NoteNode[] {
    this.host.assertOpen()
    const db = this.host.db
    const query = request.query?.trim() ?? ''
    const limit = normalizeLimit(request.limit)
    if (request.kind !== undefined && !['folder', 'document', 'file'].includes(request.kind)) throw new Error('invalid note kind')
    if (request.kind !== undefined || request.recursive || request.editableOnly) {
      const clauses: string[] = []
      const args: (string | number)[] = []
      if (query) { clauses.push("name LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(query)}%`) }
      else if (!request.recursive) {
        const parentId = normalizeParentId(request.parentId)
        if (parentId !== null) this.assertFolder(parentId)
        clauses.push('parent_key = ?'); args.push(parentKey(parentId))
      }
      if (request.kind !== undefined) { clauses.push('kind = ?'); args.push(request.kind) }
      if (request.editableOnly) clauses.push('note_is_editable(kind,name,media_type) = 1')
      return (db.prepare(`SELECT ${NOTE_COLUMNS} FROM note_nodes
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id LIMIT ?
      `).all(...args, limit) as SqlRow[]).map(mapNoteNode)
    }
    if (query.length > 0) {
      return (db.prepare(`
        SELECT ${NOTE_COLUMNS}
        FROM note_nodes
        WHERE name LIKE ? ESCAPE '\\'
        ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
        LIMIT ?
      `).all(`%${escapeLike(query)}%`, limit) as SqlRow[]).map(mapNoteNode)
    }
    const parentId = normalizeParentId(request.parentId)
    if (parentId !== null) this.assertFolder(parentId)
    return (db.prepare(`
      SELECT ${NOTE_COLUMNS}
      FROM note_nodes
      WHERE parent_key = ?
      ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
      LIMIT ?
    `).all(parentKey(parentId), limit) as SqlRow[]).map(mapNoteNode)
  }

  get(id: string): NoteNode | undefined {
    this.host.assertOpen()
    assertNoteId(id)
    const row = this.host.db.prepare(`SELECT ${NOTE_COLUMNS} FROM note_nodes WHERE id=?`).get(id) as SqlRow | undefined
    return row === undefined ? undefined : mapNoteNode(row)
  }

  listPage(request: NoteListRequest = {}, cursor?: string) {
    this.host.assertOpen()
    const db = this.host.db
    const query = request.query?.trim() || ''
    const parentId = normalizeParentId(request.parentId)
    const scope = JSON.stringify(['notes', query, query || request.recursive ? null : parentId, request.kind || '', Boolean(request.recursive), Boolean(request.editableOnly)])
    const after = decodePageCursor(cursor, scope, ['number', 'string', 'string'])
    const conditions: string[] = [], args: (string | number)[] = []
    if (request.kind && !['folder', 'document', 'file'].includes(request.kind)) throw new Error('invalid note kind')
    if (query) { conditions.push("name LIKE ? ESCAPE '\\'"); args.push(`%${escapeLike(query)}%`) }
    else if (!request.recursive) {
      if (parentId !== null) this.assertFolder(parentId)
      conditions.push('parent_key = ?'); args.push(parentKey(parentId))
    }
    if (request.kind) { conditions.push('kind = ?'); args.push(request.kind) }
    if (request.editableOnly) conditions.push('note_is_editable(kind,name,media_type) = 1')
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = Number((db.prepare(`SELECT count(*) AS total FROM note_nodes ${where}`).get(...args) as SqlRow).total)
    const rank = "CASE kind WHEN 'folder' THEN 0 ELSE 1 END"
    if (after) {
      conditions.push(`(${rank}, name COLLATE NOCASE, id) > (?, ?, ?)`)
      args.push(...after)
    }
    const size = normalizeLimit(request.limit)
    const rows = db.prepare(`SELECT ${NOTE_COLUMNS} FROM note_nodes
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY ${rank}, name COLLATE NOCASE, id LIMIT ?`).all(...args, size + 1) as SqlRow[]
    const items = rows.slice(0, size).map(mapNoteNode), last = items.at(-1)
    return { items, total, nextCursor: rows.length > size && last ? encodePageCursor(scope, [last.kind === 'folder' ? 0 : 1, last.name, last.id]) : undefined }
  }

  subtree(id: string): NoteNode[] {
    this.host.assertOpen()
    assertNoteId(id)
    const rows = this.host.db.prepare(`
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

  isWithin(rootId: string, candidateId: string): boolean {
    this.host.assertOpen()
    assertNoteId(rootId)
    assertNoteId(candidateId)
    if (rootId === candidateId) return this.get(rootId) !== undefined
    return this.host.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM note_nodes WHERE parent_id=?
        UNION ALL
        SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
      )
      SELECT 1 FROM descendants WHERE id=? LIMIT 1
    `).get(rootId, candidateId) !== undefined
  }

  async read(id: string): Promise<{ node: NoteNode; content: Buffer }> {
    const node = this.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    if (node.kind === 'folder') throw inputError('folders do not have file content')
    try {
      const blob = this.host.db.prepare('SELECT content FROM note_sync_content WHERE note_id=? AND version=?').get(id,node.version) as {content:Uint8Array}|undefined
      const content = blob ? Buffer.from(blob.content) : await readFile(objectPath(this.host.objectsPath, id))
      if (content.byteLength !== node.size) throw new Error(`note node "${id}" has an invalid stored size`)
      return { node, content }
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) throw notFound(`note content "${id}" was not found`)
      throw error
    }
  }

  /** Controlled access for the sibling submodules (shares/versions/sync/mutations). */
  tree(): NoteStoreTreeAccess {
    return {
      get: id => this.get(id),
      read: id => this.read(id),
      subtree: id => this.subtree(id),
      requireNode: id => this.requireNode(id),
      assertFolder: id => this.assertFolder(id),
      assertNameAvailable: (parentId, name, exceptId) => this.assertNameAvailable(parentId, name, exceptId),
      nameExists: (parentId, name) => this.nameExists(parentId, name),
      isDescendant: (candidateId, ancestorId) => this.isDescendant(candidateId, ancestorId),
      children: parentId => this.children(parentId),
    }
  }

  private requireNode(id: string): NoteNode {
    const node = this.get(id)
    if (node === undefined) throw notFound(`note node "${id}" was not found`)
    return node
  }

  private assertFolder(id: string): void {
    const parent = this.get(id)
    if (parent === undefined) throw notFound(`note folder "${id}" was not found`)
    if (parent.kind !== 'folder') throw inputError('parentId must identify a folder')
  }

  private assertNameAvailable(parentId: string | null, name: string, exceptId?: string): void {
    const row = this.host.db.prepare(`
      SELECT id FROM note_nodes WHERE parent_key=? AND name=? COLLATE NOCASE
    `).get(parentKey(parentId), name) as SqlRow | undefined
    if (row !== undefined && row.id !== exceptId) throw conflict(`"${name}" already exists in this folder`)
  }

  private nameExists(parentId: string | null, name: string): boolean {
    return this.host.db.prepare('SELECT 1 FROM note_nodes WHERE parent_key=? AND name=? COLLATE NOCASE')
      .get(parentKey(parentId), name) !== undefined
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    return this.host.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM note_nodes WHERE parent_id=?
        UNION ALL
        SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
      )
      SELECT 1 FROM descendants WHERE id=? LIMIT 1
    `).get(ancestorId, candidateId) !== undefined
  }

  private children(parentId: string): NoteNode[] {
    return (this.host.db.prepare(`
      SELECT ${NOTE_COLUMNS} FROM note_nodes WHERE parent_key=?
      ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
    `).all(parentId) as SqlRow[]).map(mapNoteNode)
  }
}
