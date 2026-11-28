import { randomBytes, randomUUID } from 'node:crypto'
import type { NoteShare } from './domain.js'
import {
  NOTE_COLUMNS,
  NOTE_SHARE_COLUMNS,
  NOTE_SHARE_TOKEN_PATTERN,
  assertNoteId,
  mapNoteNode,
  notFound,
  type NoteStoreHost,
  type NoteStoreTreeAccess,
  type SqlRow,
} from './note-store-internal.js'

export interface NoteStoreShareDeps extends NoteStoreHost { readonly tree: NoteStoreTreeAccess }

/** Share tokens plus the shared subtree a token exposes. */
export class NoteStoreShares {
  constructor(private readonly deps: NoteStoreShareDeps) {}

  listShares(): NoteShare[] {
    this.deps.assertOpen()
    const rows = this.deps.db.prepare(`
      SELECT ${NOTE_SHARE_COLUMNS}
      FROM note_shares s JOIN note_nodes n ON n.id=s.note_id
      ORDER BY s.updated_at DESC, s.id
    `).all() as SqlRow[]
    return rows.map(row => this.mapShare(row))
  }

  getShareByNoteId(noteId: string): NoteShare | undefined {
    this.deps.assertOpen()
    assertNoteId(noteId)
    const row = this.deps.db.prepare(`
      SELECT ${NOTE_SHARE_COLUMNS}
      FROM note_shares s JOIN note_nodes n ON n.id=s.note_id
      WHERE s.note_id=?
    `).get(noteId) as SqlRow | undefined
    return row === undefined ? undefined : this.mapShare(row)
  }

  getShareByToken(token: string): NoteShare | undefined {
    this.deps.assertOpen()
    if (!NOTE_SHARE_TOKEN_PATTERN.test(token)) return undefined
    const row = this.deps.db.prepare(`
      SELECT ${NOTE_SHARE_COLUMNS}
      FROM note_shares s JOIN note_nodes n ON n.id=s.note_id
      WHERE s.token=?
    `).get(token) as SqlRow | undefined
    return row === undefined ? undefined : this.mapShare(row)
  }

  createShare(noteId: string): NoteShare {
    this.deps.assertOpen()
    const node = this.deps.tree.requireNode(noteId)
    const existing = this.getShareByNoteId(noteId)
    if (existing !== undefined) return existing
    const id = `share_${randomUUID().replaceAll('-', '')}`
    const token = `share_${randomBytes(24).toString('base64url')}`
    const timestamp = new Date().toISOString()
    const result = this.deps.db.prepare(`
      INSERT INTO note_shares(id,note_id,token,created_at,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(note_id) DO NOTHING
    `).run(id, noteId, token, timestamp, timestamp)
    if (result.changes === 0) return this.getShareByNoteId(noteId) as NoteShare
    return { id, noteId, token, createdAt: timestamp, updatedAt: timestamp, node }
  }

  deleteShare(noteId: string): boolean {
    this.deps.assertOpen()
    assertNoteId(noteId)
    return this.deps.db.prepare('DELETE FROM note_shares WHERE note_id=?').run(noteId).changes === 1
  }

  listSharedSubtree(id: string, limit = 500): import('./domain.js').NoteNode[] {
    this.deps.assertOpen()
    assertNoteId(id)
    const boundedLimit = Number.isInteger(limit) ? Math.min(1000, Math.max(1, limit)) : 500
    const rows = this.deps.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM note_nodes WHERE id=?
        UNION ALL
        SELECT child.id FROM note_nodes child JOIN descendants parent ON child.parent_id=parent.id
      )
      SELECT ${NOTE_COLUMNS} FROM note_nodes WHERE id IN (SELECT id FROM descendants)
      ORDER BY CASE kind WHEN 'folder' THEN 0 ELSE 1 END, name COLLATE NOCASE, id
      LIMIT ?
    `).all(id, boundedLimit) as SqlRow[]
    if (rows.length === 0) throw notFound(`note node "${id}" was not found`)
    return rows.map(mapNoteNode)
  }

  private mapShare(row: SqlRow): NoteShare {
    const noteId = String(row.note_id)
    const node = mapNoteNode({
      id: row.node_id,
      parent_id: row.node_parent_id,
      parent_key: row.node_parent_key,
      kind: row.node_kind,
      name: row.node_name,
      media_type: row.node_media_type,
      size: row.node_size,
      sha256: row.node_sha256,
      version: row.node_version,
      created_at: row.node_created_at,
      updated_at: row.node_updated_at,
    })
    return {
      id: String(row.share_id),
      noteId,
      token: String(row.token),
      createdAt: String(row.share_created_at),
      updatedAt: String(row.share_updated_at),
      node,
    }
  }
}
