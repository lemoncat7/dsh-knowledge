import { createHash } from 'node:crypto'
import type { NoteNode } from './domain.js'

export const NOTE_SYNC_PROTOCOL = 1
export interface NoteSyncChange {
  instance: string
  operationId: string
  id: string
  base: string | null
  // Deletes compare the entire subtree, not just the directory's timestamp.
  subtree?: string
  value: {
    kind: NoteNode['kind']
    name: string
    parentId: string | null
    mediaType: string | null
    content: string
  } | null
}
export interface NoteManifest {
  protocol: number
  instance: string
  revision: string
  nodes: NoteNode[]
}
export function noteFingerprint(node: NoteNode | undefined | null): string | null {
  return node
    ? hash(
        JSON.stringify([
          node.id,
          node.kind,
          node.parentId,
          node.name,
          node.mediaType,
          node.sha256,
          node.version,
          node.createdAt,
          node.updatedAt,
        ]),
      )
    : null
}
export function treeFingerprint(nodes: NoteNode[]): string {
  return hash(
    JSON.stringify(
      nodes.map((n) => [n.id, noteFingerprint(n)]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ),
  )
}
export function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}
export function syncError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status })
}
