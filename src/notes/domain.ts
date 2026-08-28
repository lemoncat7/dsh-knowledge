export type NoteNodeKind = 'folder' | 'document' | 'file'

export interface NoteNode {
  id: string
  parentId: string | null
  kind: NoteNodeKind
  name: string
  mediaType: string | null
  editable: boolean
  size: number
  sha256: string | null
  createdAt: string
  updatedAt: string
}

export interface NoteReference {
  noteId: string
  knowledgeBaseId: string
  documentId: string
  documentTitle: string
}

export interface NoteListRequest {
  parentId?: string | null
  query?: string
  limit?: number
}

export interface NoteFileUpload {
  parentId?: string | null
  name: string
  mediaType: string
  content: Uint8Array
}

const EDITABLE_NOTE_MEDIA_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/toml',
  'application/xml',
  'application/x-javascript',
  'application/x-yaml',
  'application/yaml',
])

const EDITABLE_NOTE_EXTENSIONS = new Set([
  'bash', 'c', 'cjs', 'conf', 'cpp', 'css', 'csv', 'env', 'fish', 'go', 'h', 'hpp',
  'htm', 'html', 'ini', 'java', 'js', 'json', 'jsonc', 'jsx', 'less', 'log', 'markdown',
  'md', 'mjs', 'properties', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'svelte', 'toml',
  'ts', 'tsv', 'tsx', 'txt', 'vue', 'xml', 'yaml', 'yml', 'zsh',
])

const NOTE_ID_PATTERN = /^note_[a-f0-9]{32}$/

export function isNoteId(value: string): boolean {
  return NOTE_ID_PATTERN.test(value)
}

export function isEditableNoteNode(node: Pick<NoteNode, 'kind' | 'name' | 'mediaType'>): boolean {
  if (node.kind === 'document') return true
  if (node.kind !== 'file') return false
  const mediaType = node.mediaType?.toLocaleLowerCase() ?? ''
  if (mediaType.startsWith('text/') || EDITABLE_NOTE_MEDIA_TYPES.has(mediaType)) return true
  const name = node.name.toLocaleLowerCase()
  const dot = name.lastIndexOf('.')
  return EDITABLE_NOTE_EXTENSIONS.has(dot >= 0 ? name.slice(dot + 1) : name)
}

export function noteReferenceMarkdown(node: Pick<NoteNode, 'id' | 'name'>): string {
  return `@[${escapeMarkdownLabel(node.name)}](note://${node.id})`
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')
}
