import type { KnowledgeProvider } from './provider.js'
import type { NoteNode } from './notes/domain.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import type { RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { assertExplicitKnowledgeNoteRequest } from './tool-authorization.js'
import { readMountedKnowledge, type KnowledgeHandleCodec } from './retrieval.js'
import { optionalToolInteger, requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'

const MAX_TOOL_NOTE_CONTENT = 200_000

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
} as const

/** Note operations use session handles. Mounted references authorize content access; other mutations require direct user requests. */
export function registerKnowledgeNoteTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  codec: KnowledgeNoteHandleCodec,
  knowledgeCodec: KnowledgeHandleCodec,
): void {
  ctx.tools.register(listNotesTool(provider, codec))
  ctx.tools.register(readNoteTool(provider, codec, knowledgeCodec))
  ctx.tools.register(createNoteTool(provider, codec))
  ctx.tools.register(updateNoteTool(provider, codec, knowledgeCodec))
  ctx.tools.register(moveNoteTool(provider, codec))
  ctx.tools.register(deleteNoteTool(provider, codec))
}

function listNotesTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_list',
    description: 'Browse one folder in the independent note workspace, or search note and folder names. Use this when the user explicitly asks to inspect, create, organize, or edit notes. Omit folderHandle to browse the root. Handles are session-bound; pass exact returned handles to other knowledge_note tools.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        folderHandle: { type: 'string', description: 'Exact signed folder handle returned by this tool. Omit for the note-workspace root.' },
        query: { type: 'string', description: 'Optional name search across the whole note workspace. Cannot be combined with folderHandle.' },
        limit: { type: 'integer', description: 'Maximum results, default 50 and maximum 100.' },
      },
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      assertExplicitKnowledgeNoteRequest(agent, 'inspect')
      const args = toolRecord(raw)
      const query = optionalText(args.query, 'query', 1000)
      const folderHandle = optionalText(args.folderHandle, 'folderHandle', 4096)
      if (query !== undefined && folderHandle !== undefined) throw new Error('query and folderHandle cannot be combined')
      const limit = optionalToolInteger(args.limit, 'limit', 1, 100) ?? 50
      let parentId: string | null = null
      let folder: NoteNode | undefined
      if (folderHandle !== undefined) {
        folder = await resolveNoteHandle(provider, codec, agent.session.id, folderHandle, exec.signal)
        if (folder.kind !== 'folder') throw new Error('folderHandle must identify a note folder')
        parentId = folder.id
      }
      const nodes = await provider.listNotes(query === undefined ? { parentId, limit } : { query, limit }, exec.signal)
      return JSON.stringify({
        storage: provider.mode,
        scope: query === undefined ? { folder: folder?.name ?? 'root' } : { query },
        items: nodes.map(node => noteView(node, codec.encode(agent.session.id, node.id))),
      }, null, 2)
    },
  }
}

async function authorizeReferencedNote(provider: KnowledgeProvider, codec: KnowledgeHandleCodec, exec: ToolRunContextLike, knowledgeHandle: unknown, noteId: string): Promise<void> {
  const agent = requireToolAgent(exec, 'knowledge note tools')
  const { entry } = await readMountedKnowledge(provider, agent, requiredToolString(knowledgeHandle, 'knowledgeHandle', 4096), codec, exec.signal)
  const references = await provider.listKnowledgeNoteReferences(entry.id, exec.signal)
  if (!references.some(reference => reference.note.id === noteId)) throw new Error('note is not referenced by this mounted knowledge document')
}

function readNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec, knowledgeCodec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_read',
    description: 'Read a bounded chunk from an editable text or Markdown note after knowledge_note_list/search returned its exact handle. This never reads folders or binary attachments. Use offset and maxChars to continue long notes.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string', description: 'Exact signed note handle returned by knowledge_note_list or knowledge_note_search.' },
        knowledgeHandle: { type: 'string', description: 'Optional mounted knowledge handle: its current note reference authorizes reading without a new direct user request. Obtain noteHandle from knowledge_note_references list.' },
        offset: { type: 'integer', description: 'Character offset, default 0.' },
        maxChars: { type: 'integer', description: 'Maximum returned characters, default 20000 and maximum 80000.' },
      },
      required: ['noteHandle'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const handle = requiredToolString(args.noteHandle, 'noteHandle', 4096)
      const offset = optionalToolInteger(args.offset, 'offset', 0, 50_000_000) ?? 0
      const maxChars = optionalToolInteger(args.maxChars, 'maxChars', 1, 80_000) ?? 20_000
      const node = await resolveNoteHandle(provider, codec, agent.session.id, handle, exec.signal)
      if (args.knowledgeHandle !== undefined) await authorizeReferencedNote(provider, knowledgeCodec, exec, args.knowledgeHandle, node.id)
      else assertExplicitKnowledgeNoteRequest(agent, 'inspect')
      if (!node.editable || node.kind === 'folder') throw new Error('knowledge_note_read only supports editable text and Markdown notes')
      const { node: snapshot, content } = await provider.readNote(node.id, exec.signal)
      const text = decodeTextNote(content)
      const chunk = text.slice(offset, offset + maxChars)
      return JSON.stringify({
        storage: provider.mode,
        note: noteView(snapshot, handle),
        offset,
        content: chunk,
        nextOffset: offset + chunk.length < text.length ? offset + chunk.length : null,
        totalChars: text.length,
      }, null, 2)
    },
  }
}

function createNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_create',
    description: 'Create a Markdown note or folder in the active local or remote note workspace only when the current user explicitly asks. Omit parentFolderHandle to create at the root. The tool follows the active provider and never copies or synchronizes between local and remote storage.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        kind: { type: 'string', enum: ['document', 'folder'] },
        name: { type: 'string', description: 'Document title/filename or folder name.' },
        parentFolderHandle: { type: 'string', description: 'Exact signed folder handle returned by knowledge_note_list. Omit for root.' },
        content: { type: 'string', description: 'Initial Markdown content for a document. Omit for a folder.' },
      },
      required: ['kind', 'name'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const kind = noteKind(args.kind)
      assertExplicitKnowledgeNoteRequest(agent, 'create', kind === 'folder' ? 'folder' : 'document')
      const name = requiredToolString(args.name, 'name', 255)
      const content = optionalContent(args.content, 'content') ?? ''
      if (kind === 'folder' && args.content !== undefined) throw new Error('content must be omitted when creating a folder')
      const parentId = await resolveOptionalFolderId(provider, codec, agent.session.id, args.parentFolderHandle, 'parentFolderHandle', exec.signal)
      const node = kind === 'folder'
        ? await provider.createNoteFolder(name, parentId, exec.signal)
        : await provider.createNoteDocument(name, parentId, content, exec.signal)
      return mutationResult(provider, 'created', node, codec.encode(agent.session.id, node.id))
    },
  }
}

function updateNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec, knowledgeCodec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_update',
    description: 'Update an existing note. A current reference from a mounted knowledge document authorizes append_content/replace_content without another user request: pass knowledgeHandle and its referenced noteHandle. This never authorizes editing the knowledge document, renaming, moving or deleting notes. Otherwise an explicit user request is required. Read before writing; append_content preserves the existing body, replace_content replaces the complete body. Do not write unchanged observations.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string', description: 'Exact signed handle returned by knowledge_note_list or knowledge_note_search.' },
        knowledgeHandle: { type: 'string', description: 'Mounted knowledge document referencing this note. Checked against current mounts and references on every call; partner heartbeat uses its dedicated recording tool.' },
        operation: { type: 'string', enum: ['rename', 'replace_content', 'append_content'] },
        expectedVersion: { type: 'integer', minimum: 1, description: 'For content updates, pass note.version from knowledge_note_read. A stale version is rejected; reread and merge instead of overwriting.' },
        value: { type: 'string', description: 'New name or content, according to operation.' },
      },
      required: ['noteHandle', 'operation', 'value'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const handle = requiredToolString(args.noteHandle, 'noteHandle', 4096)
      const operation = updateOperation(args.operation)
      const node = await resolveNoteHandle(provider, codec, agent.session.id, handle, exec.signal)
      if (args.knowledgeHandle !== undefined && operation !== 'rename') await authorizeReferencedNote(provider, knowledgeCodec, exec, args.knowledgeHandle, node.id)
      else assertExplicitKnowledgeNoteRequest(agent, 'update', node.kind === 'folder' ? 'folder' : 'document')
      let updated: NoteNode
      if (operation === 'rename') {
        updated = await provider.renameNote(node.id, requiredToolString(args.value, 'value', 255), exec.signal)
      } else {
        if (!node.editable || node.kind === 'folder') throw new Error('only editable text and Markdown notes support content updates')
        const expectedVersion = optionalToolInteger(args.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === undefined) throw new Error('请先用 knowledge_note_read 读取笔记，并提供返回的 note.version 作为 expectedVersion')
        if (node.version !== expectedVersion) throw new Error('笔记已变化，请重新读取并合并后更新')
        const value = requiredContent(args.value, 'value')
        const content = operation === 'append_content'
          ? `${decodeTextNote((await provider.readNote(node.id, exec.signal)).content)}${value}`
          : value
        updated = await provider.updateNoteContent(node.id, new TextEncoder().encode(content), exec.signal, expectedVersion)
      }
      return mutationResult(provider, 'updated', updated, codec.encode(agent.session.id, updated.id))
    },
  }
}

function moveNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_move',
    description: 'Move a note or folder only when the user explicitly asks. Use exact signed handles. Omit targetFolderHandle to move the item to the note-workspace root.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string' },
        targetFolderHandle: { type: 'string', description: 'Exact destination-folder handle; omit for root.' },
      },
      required: ['noteHandle'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const handle = requiredToolString(args.noteHandle, 'noteHandle', 4096)
      const node = await resolveNoteHandle(provider, codec, agent.session.id, handle, exec.signal)
      assertExplicitKnowledgeNoteRequest(agent, 'move', node.kind === 'folder' ? 'folder' : 'document')
      const parentId = await resolveOptionalFolderId(provider, codec, agent.session.id, args.targetFolderHandle, 'targetFolderHandle', exec.signal)
      const moved = await provider.moveNote(node.id, parentId, exec.signal)
      return mutationResult(provider, 'moved', moved, codec.encode(agent.session.id, moved.id))
    },
  }
}

function deleteNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_delete',
    description: 'Permanently delete one note or folder only when the current user explicitly asks. Requires an exact signed handle. Referenced notes are protected; remote deletion also requires an admin-capable token.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { noteHandle: { type: 'string', description: 'Exact signed handle returned by knowledge_note_list or knowledge_note_search.' } },
      required: ['noteHandle'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const handle = requiredToolString(args.noteHandle, 'noteHandle', 4096)
      const node = await resolveNoteHandle(provider, codec, agent.session.id, handle, exec.signal)
      assertExplicitKnowledgeNoteRequest(agent, 'delete', node.kind === 'folder' ? 'folder' : 'document')
      await provider.deleteNote(node.id, exec.signal)
      return JSON.stringify({ storage: provider.mode, operation: 'deleted', note: { name: node.name, kind: node.kind } }, null, 2)
    },
  }
}

async function resolveNoteHandle(
  provider: KnowledgeProvider,
  codec: KnowledgeNoteHandleCodec,
  sessionId: string,
  handle: string,
  signal?: AbortSignal,
): Promise<NoteNode> {
  const { noteId } = codec.decode(handle, sessionId)
  const node = await provider.getNote(noteId, signal)
  if (node === undefined) throw new Error('the note handle points to a note that no longer exists')
  return node
}

async function resolveOptionalFolderId(
  provider: KnowledgeProvider,
  codec: KnowledgeNoteHandleCodec,
  sessionId: string,
  value: unknown,
  label: string,
  signal?: AbortSignal,
): Promise<string | null> {
  if (value === undefined) return null
  const handle = requiredToolString(value, label, 4096)
  const node = await resolveNoteHandle(provider, codec, sessionId, handle, signal)
  if (node.kind !== 'folder') throw new Error('the parent handle must identify a note folder')
  return node.id
}

function noteView(node: NoteNode, handle: string): Record<string, unknown> {
  return {
    handle,
    name: node.name,
    kind: node.kind,
    mediaType: node.mediaType,
    editable: node.editable,
    version: node.version,
    size: node.size,
    updatedAt: node.updatedAt,
  }
}

function mutationResult(provider: KnowledgeProvider, operation: string, node: NoteNode, handle: string): string {
  return JSON.stringify({ storage: provider.mode, operation, note: noteView(node, handle) }, null, 2)
}

function optionalText(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return requiredToolString(value, name, maxLength)
}

function optionalContent(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return noteContent(value, name)
}

function requiredContent(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  return noteContent(value, name)
}

function noteContent(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (value.length > MAX_TOOL_NOTE_CONTENT) throw new Error(`${name} must contain at most ${MAX_TOOL_NOTE_CONTENT} characters`)
  return value
}

function noteKind(value: unknown): 'document' | 'folder' {
  if (value !== 'document' && value !== 'folder') throw new Error('kind must be document or folder')
  return value
}

function updateOperation(value: unknown): 'rename' | 'replace_content' | 'append_content' {
  if (value !== 'rename' && value !== 'replace_content' && value !== 'append_content') {
    throw new Error('operation must be rename, replace_content, or append_content')
  }
  return value
}

function decodeTextNote(content: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content)
  } catch {
    throw new Error('the note content is not valid UTF-8 text')
  }
}
