import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isEditableNoteNode, type NoteFileUpload, type NoteListRequest, type NoteNode, type NoteNodeKind, type NoteShare, type NoteVersion } from './domain.js'
import { migrateNotes } from './note-store-schema.js'
import { NoteStoreCrud } from './note-store-crud.js'
import { NoteStoreMutations } from './note-store-mutations.js'
import { NoteStoreShares } from './note-store-shares.js'
import { NoteStoreVersions } from './note-store-versions.js'
import { NoteStoreSync } from './note-store-sync.js'
import type { NoteStoreHost } from './note-store-internal.js'
import type { NoteSyncChange, NoteManifest } from './sync-protocol.js'

export { normalizeNoteName } from './note-store-internal.js'

/**
 * Node-tree store skeleton: owns the database, filesystem paths, the per-node content lock and the
 * initialization/migration lifecycle, and delegates each note subdomain to its own module.
 */
export class NoteStore {
  private readonly db: DatabaseSync
  private readonly objectsPath: string
  private readonly versionsPath: string
  private readonly contentMutationTails = new Map<string, Promise<void>>()
  private closed = false
  private readonly crud: NoteStoreCrud
  private readonly mutations: NoteStoreMutations
  private readonly shares: NoteStoreShares
  private readonly versions: NoteStoreVersions
  private readonly sync: NoteStoreSync

  constructor(private readonly rootPath: string, private readonly removeOnClose = false) {
    this.objectsPath = join(rootPath, 'objects')
    this.versionsPath = join(rootPath, 'versions')
    mkdirSync(this.objectsPath, { recursive: true, mode: 0o700 })
    mkdirSync(this.versionsPath, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(rootPath, 'notes.sqlite'))
    this.db.function('note_is_editable', { deterministic: true }, (kind, name, mediaType) =>
      isEditableNoteNode({ kind: String(kind) as NoteNodeKind, name: String(name),
        mediaType: mediaType === null ? null : String(mediaType) }) ? 1 : 0)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    migrateNotes(this.db, { objectsPath: this.objectsPath, versionsPath: this.versionsPath })
    this.db.exec('CREATE TABLE IF NOT EXISTS note_version_sources(note_id TEXT NOT NULL, version INTEGER NOT NULL, source TEXT NOT NULL, PRIMARY KEY(note_id,version));')
    this.db.exec(`CREATE TABLE IF NOT EXISTS note_sync_content(note_id TEXT NOT NULL REFERENCES note_nodes(id) ON DELETE CASCADE, version INTEGER NOT NULL, content BLOB NOT NULL, PRIMARY KEY(note_id,version));
      CREATE TABLE IF NOT EXISTS note_sync_receipts(actor TEXT NOT NULL, operation_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(actor,operation_id));
      CREATE TABLE IF NOT EXISTS note_sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=4;`)
    this.db.prepare("INSERT OR IGNORE INTO note_sync_meta VALUES('instance',?)").run(randomUUID())
    this.db.exec("CREATE INDEX IF NOT EXISTS note_page_order ON note_nodes(parent_key, (CASE kind WHEN 'folder' THEN 0 ELSE 1 END), name COLLATE NOCASE, id);")
    const host: NoteStoreHost = {
      db: this.db,
      objectsPath: this.objectsPath,
      versionsPath: this.versionsPath,
      contentMutationTails: this.contentMutationTails,
      assertOpen: () => this.assertOpen(),
    }
    this.crud = new NoteStoreCrud(host)
    this.mutations = new NoteStoreMutations({ ...host, tree: this.crud.tree() })
    this.shares = new NoteStoreShares({ ...host, tree: this.crud.tree() })
    this.versions = new NoteStoreVersions({ ...host, tree: this.crud.tree() })
    this.sync = new NoteStoreSync({ ...host, tree: this.crud.tree() })
  }

  list(request: NoteListRequest = {}): NoteNode[] { return this.crud.list(request) }

  get(id: string): NoteNode | undefined { return this.crud.get(id) }

  listPage(request: NoteListRequest = {}, cursor?: string) { return this.crud.listPage(request, cursor) }

  subtree(id: string): NoteNode[] { return this.crud.subtree(id) }

  listSharedSubtree(id: string, limit = 500): NoteNode[] { return this.shares.listSharedSubtree(id, limit) }

  isWithin(rootId: string, candidateId: string): boolean { return this.crud.isWithin(rootId, candidateId) }

  listShares(): NoteShare[] { return this.shares.listShares() }

  getShareByNoteId(noteId: string): NoteShare | undefined { return this.shares.getShareByNoteId(noteId) }

  getShareByToken(token: string): NoteShare | undefined { return this.shares.getShareByToken(token) }

  createShare(noteId: string): NoteShare { return this.shares.createShare(noteId) }

  deleteShare(noteId: string): boolean { return this.shares.deleteShare(noteId) }

  async createFolder(name: string, parentId: string | null = null): Promise<NoteNode> { return this.mutations.createFolder(name, parentId) }

  async createDocument(name: string, parentId: string | null = null, content = ''): Promise<NoteNode> { return this.mutations.createDocument(name, parentId, content) }

  async upload(upload: NoteFileUpload): Promise<NoteNode> { return this.mutations.upload(upload) }

  async read(id: string): Promise<{ node: NoteNode; content: Buffer }> { return this.crud.read(id) }

  async readPreview(id: string, maximumBytes: number): Promise<{ node: NoteNode; content: Buffer; truncated: boolean }> { return this.versions.readPreview(id, maximumBytes) }

  async readSnapshot(id: string): Promise<{ node: NoteNode; content: Buffer }> { return this.versions.readSnapshot(id) }

  async updateContent(id: string, content: Uint8Array, expectedVersion?: number, source = '应用修改'): Promise<NoteNode> {
    return this.versions.updateContent(id, content, expectedVersion, source)
  }

  listVersions(id: string, limit = 100): NoteVersion[] { return this.versions.listVersions(id, limit) }

  async readVersion(id: string, version: number): Promise<{ node: NoteNode; version: NoteVersion; content: Buffer }> {
    return this.versions.readVersion(id, version)
  }

  async restoreVersion(id: string, version: number, expectedVersion?: number): Promise<NoteNode> {
    return this.versions.restoreVersion(id, version, expectedVersion)
  }

  relocate(id: string, name: string, parentId: string | null, expected: string): Promise<NoteNode> {
    return this.mutations.relocate(id, name, parentId, expected)
  }

  rename(id: string, name: string): NoteNode { return this.mutations.rename(id, name) }

  move(id: string, parentId: string | null): NoteNode { return this.mutations.move(id, parentId) }

  async copy(id: string, parentId?: string | null, requestedName?: string): Promise<NoteNode> {
    return this.mutations.copy(id, parentId, requestedName)
  }

  async delete(id: string): Promise<void> { return this.mutations.delete(id) }

  syncManifest(): NoteManifest { return this.sync.syncManifest() }

  applySyncChange(actor: string, change: NoteSyncChange): NoteNode | null { return this.sync.applySyncChange(actor, change) }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.db.close()
    if (this.removeOnClose) await rm(this.rootPath, { recursive: true, force: true })
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('note store is closed')
  }
}
