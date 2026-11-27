import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { isEditableNoteNode, isNoteId, type NoteNode, type NoteNodeKind, type NoteVersion } from './domain.js'
import type { NoteManifest } from './sync-protocol.js'

export type SqlRow = Record<string, unknown>

export const MAX_NOTE_BYTES = 64 * 1024 * 1024
export const MAX_NOTE_NAME_LENGTH = 255
export const NOTE_SHARE_TOKEN_PATTERN = /^share_[A-Za-z0-9_-]{32}$/

export const NOTE_COLUMNS = 'id,parent_id,parent_key,kind,name,media_type,size,sha256,version,created_at,updated_at'
export const NOTE_SHARE_COLUMNS = `
  s.id AS share_id,s.note_id,s.token,s.created_at AS share_created_at,s.updated_at AS share_updated_at,
  n.id AS node_id,n.parent_id AS node_parent_id,n.parent_key AS node_parent_key,n.kind AS node_kind,
  n.name AS node_name,n.media_type AS node_media_type,n.size AS node_size,n.sha256 AS node_sha256,
  n.version AS node_version,n.created_at AS node_created_at,n.updated_at AS node_updated_at
`

/** The shared, controlled surface every note-store submodule receives from NoteStore. */
export interface NoteStoreHost {
  readonly db: DatabaseSync
  readonly objectsPath: string
  readonly versionsPath: string
  readonly contentMutationTails: Map<string, Promise<void>>
  /** Mutable holder so cached manifest reads survive across submodule calls. */
  readonly manifestCache: { value: { revision: string; manifest: NoteManifest } | undefined }
  assertOpen(): void
}

/** Node-tree operations other submodules may call; never expands NoteStore's public API. */
export interface NoteStoreTreeAccess {
  get(id: string): NoteNode | undefined
  read(id: string): Promise<{ node: NoteNode; content: Buffer }>
  subtree(id: string): NoteNode[]
  requireNode(id: string): NoteNode
  assertFolder(id: string): void
  assertNameAvailable(parentId: string | null, name: string, exceptId?: string): void
  nameExists(parentId: string | null, name: string): boolean
  isDescendant(candidateId: string, ancestorId: string): boolean
  children(parentId: string): NoteNode[]
}

/** Serializes content mutations per node; the only lock boundary for note content. */
export function enqueueContentMutation<T>(
  tails: Map<string, Promise<void>>,
  id: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(id) ?? Promise.resolve()
  const result = previous.then(operation, operation)
  const tail = result.then(() => undefined, () => undefined)
  tails.set(id, tail)
  void tail.then(() => {
    if (tails.get(id) === tail) tails.delete(id)
  })
  return result
}

export function objectPath(objectsPath: string, id: string): string {
  assertNoteId(id)
  return join(objectsPath, id)
}

export function versionDirectory(versionsPath: string, id: string): string {
  assertNoteId(id)
  return join(versionsPath, id)
}

export function versionPath(versionsPath: string, id: string, version: number): string {
  return join(versionDirectory(versionsPath, id), String(normalizeVersion(version)))
}

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

export function normalizeMediaType(value: string): string {
  const mediaType = value.trim().toLowerCase() || 'application/octet-stream'
  if (mediaType.length > 255 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\s*;.*)?$/.test(mediaType)) {
    throw inputError('note media type is invalid')
  }
  return mediaType.split(';', 1)[0] as string
}

export function normalizeParentId(value: string | null | undefined): string | null {
  if (value === undefined || value === null || value === '') return null
  assertNoteId(value)
  return value
}

export function parentKey(value: string | null): string {
  return value ?? ''
}

export function normalizeLimit(value: number | undefined): number {
  return Number.isInteger(value) ? Math.min(500, Math.max(1, value as number)) : 200
}

export function mapNoteNode(row: SqlRow): NoteNode {
  const node = {
    id: String(row.id),
    parentId: row.parent_id === null ? null : String(row.parent_id),
    kind: String(row.kind) as NoteNodeKind,
    name: String(row.name),
    mediaType: row.media_type === null ? null : String(row.media_type),
    size: Number(row.size),
    sha256: row.sha256 === null ? null : String(row.sha256),
    version: Number(row.version),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }
  return { ...node, editable: isEditableNoteNode(node) }
}

export function mapNoteVersion(row: SqlRow): NoteVersion {
  return {
    noteId: String(row.note_id),
    version: Number(row.version),
    name: String(row.name),
    mediaType: row.media_type === null ? null : String(row.media_type),
    size: Number(row.size),
    sha256: String(row.sha256),
    createdAt: String(row.created_at),
  }
}

export function normalizeVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw inputError('note version is invalid')
  return value
}

export function assertNoteId(id: string): void {
  if (!isNoteId(id)) throw inputError('note id is invalid')
}

export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

export function inputError(message: string): Error {
  return Object.assign(new Error(message), { code: 'BAD_REQUEST', status: 400 })
}

export function sizeError(message: string): Error {
  return Object.assign(new Error(message), { code: 'PAYLOAD_TOO_LARGE', status: 413 })
}

export function conflict(message: string): Error {
  return Object.assign(new Error(message), { code: 'CONFLICT', status: 409 })
}

export function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: 'NOT_FOUND', status: 404 })
}

export function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code
}
