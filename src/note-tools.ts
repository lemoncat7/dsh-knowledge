import type { KnowledgeProvider } from './provider.js'
import type { NoteNode } from './notes/domain.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import type { RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { assertExplicitKnowledgeNoteRequest } from './tool-authorization.js'
import { readMountedKnowledge, type KnowledgeHandleCodec } from './retrieval.js'
import { optionalToolInteger, requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'
import { noteConfirmationTools, requestNoteConfirmation } from './note-confirmation.js'

const MAX_TOOL_NOTE_CONTENT = 200_000

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
} as const

/** Reads need no semantic grant. Session handles and explicit mutation consent remain independent. */
export function registerKnowledgeNoteTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  codec: KnowledgeNoteHandleCodec,
  knowledgeCodec: KnowledgeHandleCodec,
): void {
  ctx.tools.register(listNotesTool(provider, codec))
  ctx.tools.register(readNoteTool(provider, codec, knowledgeCodec))
  const confirmable = noteConfirmationTools(ctx)
  ctx.tools.register(confirmable(createNoteTool(ctx, provider, codec)))
  ctx.tools.register(confirmable(updateNoteTool(ctx, provider, codec, knowledgeCodec)))
  ctx.tools.register(confirmable(moveNoteTool(ctx, provider, codec)))
  ctx.tools.register(deleteNoteTool(provider, codec))
}

function listNotesTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_list',
    description: 'Browse or search the independent note workspace without an extra user authorization request. Read access does not authorize mutations. Omit folderHandle to browse the root. Handles are session-bound; pass exact returned handles to other knowledge_note tools.',
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

function readNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec, _knowledgeCodec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_read',
    description: 'Read a bounded chunk from an editable text or Markdown note after knowledge_note_list/search returned its exact handle. This never reads folders or binary attachments. Use offset and maxChars to continue long notes.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string', description: 'Exact signed note handle returned by knowledge_note_list or knowledge_note_search.' },
        knowledgeHandle: { type: 'string', description: 'Optional legacy reference metadata. Reading requires only a valid session-bound noteHandle, not a knowledge mount or user authorization.' },
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

function createNoteTool(ctx: RuntimeContextLike, provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_create',
    description: 'Propose creating a note or folder from natural user intent. This tool asks the user for one-shot approval before writing; no prescribed user wording is needed. Omit parentFolderHandle for root. Do not repeatedly ask after rejection.',
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
      const name = requiredToolString(args.name, 'name', 255)
      const content = optionalContent(args.content, 'content') ?? ''
      if (kind === 'folder' && args.content !== undefined) throw new Error('content must be omitted when creating a folder')
      const parentId = await resolveOptionalFolderId(provider, codec, agent.session.id, args.parentFolderHandle, 'parentFolderHandle', exec.signal)
      const parent = parentId === null ? '根目录' : (await provider.getNote(parentId, exec.signal))?.name ?? parentId
      await approveNoteMutation(ctx, exec, 'knowledge_note_create', `创建${kind === 'folder' ? '目录' : '笔记'}「${name}」\n目标目录：${parent}\n${content.slice(0, 600)}${content.length > 600 ? '\n（预览已截断）' : ''}`)
      const node = kind === 'folder'
        ? await provider.createNoteFolder(name, parentId, exec.signal)
        : await provider.createNoteDocument(name, parentId, content, exec.signal)
      return mutationResult(provider, 'created', node, codec.encode(agent.session.id, node.id))
    },
  }
}

function updateNoteTool(ctx: RuntimeContextLike, provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec, knowledgeCodec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_update',
    description: 'Propose a note update from natural user intent. The tool obtains one-shot user approval for the exact change; do not ask the user to repeat a prescribed phrase. Read first and pass expectedVersion. append_content preserves the body; replace_content overwrites the entire body and the confirmation explicitly warns of this. Do not retry after rejection or write unchanged observations.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string', description: 'Exact signed handle returned by knowledge_note_list or knowledge_note_search.' },
        knowledgeHandle: { type: 'string', description: 'Mounted knowledge document referencing this note. Checked against current mounts and references on every call; partner heartbeat uses its dedicated recording tool.' },
        operation: { type: 'string', enum: ['rename', 'replace_range', 'replace_content', 'append_content'], description: 'Prefer replace_range for editing, merging or removing existing sections. Never append a replacement section or regenerate the untouched document.' },
        oldText: { type: 'string', description: 'For replace_range: exact existing text copied from knowledge_note_read. Must match exactly once. value replaces only this text; all other characters are preserved by the server.' },
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
      let updated: NoteNode
      if (operation === 'rename') {
        const name = requiredToolString(args.value, 'value', 255)
        if (name === node.name) throw new Error('名称未变化，不生成待确认提案')
        await approveNoteMutation(ctx, exec, 'knowledge_note_update', `改名：「${node.name}」→「${name}」\n原版本：${node.version}，原目录：${node.parentId ?? '根目录'}`)
        await assertNoteUnchanged(provider, node, exec.signal)
        updated = await provider.renameNote(node.id, name, exec.signal)
      } else {
        if (!node.editable || node.kind === 'folder') throw new Error('only editable text and Markdown notes support content updates')
        const expectedVersion = optionalToolInteger(args.expectedVersion, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER)
        if (expectedVersion === undefined) throw new Error('请先用 knowledge_note_read 读取笔记，并提供返回的 note.version 作为 expectedVersion')
        if (node.version !== expectedVersion) throw new Error('笔记已变化，请重新读取并合并后更新')
        const value = requiredContent(args.value, 'value')
        const original = decodeTextNote((await provider.readNote(node.id, exec.signal)).content)
        let content: string
        let change: string
        if (operation === 'replace_range') {
          const oldText = requiredContent(args.oldText, 'oldText')
          if (!oldText.trim()) throw new Error('局部替换必须提供非空原文，不接受空行定位')
          const start = original.indexOf(oldText)
          if (start < 0 || original.indexOf(oldText, start + 1) >= 0) throw new Error('原文必须精确且唯一匹配，请重新读取并补足上下文；未生成提案')
          content = original.slice(0, start) + value + original.slice(start + oldText.length)
          change = `局部替换：第 ${start + 1}–${start + oldText.length} 字符；范围外 ${original.length - oldText.length} 字符原样保留\n原文预览：${oldText.slice(0, 300)}`
        } else {
          content = operation === 'append_content' ? original + value : value
          change = operation === 'append_content' ? '末尾追加（不会删除或合并已有章节）' : '警告：整篇覆盖，将替换全部原文；局部修改应改用 replace_range'
        }
        if (content.replace(/\s/gu, '') === original.replace(/\s/gu, '')) throw new Error('内容未变化或仅有空白变化，不生成待确认提案')
        await approveNoteMutation(ctx, exec, 'knowledge_note_update', `${change}：${node.name}\n版本：${expectedVersion}\n新内容（${value.length} 字符）：\n${value.slice(0, 600)}${value.length > 600 ? '\n（预览已截断）' : ''}`)
        await assertNoteUnchanged(provider, node, exec.signal)
        updated = await provider.updateNoteContent(node.id, new TextEncoder().encode(content), exec.signal, expectedVersion)
      }
      return mutationResult(provider, 'updated', updated, codec.encode(agent.session.id, updated.id))
    },
  }
}

function moveNoteTool(ctx: RuntimeContextLike, provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_move',
    description: 'Propose moving a note or folder; this tool requests one-shot user approval showing the item and destination, without prescribed user wording. Use exact signed handles. Omit targetFolderHandle for root. Do not retry after rejection.',
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
      const parentId = await resolveOptionalFolderId(provider, codec, agent.session.id, args.targetFolderHandle, 'targetFolderHandle', exec.signal)
      const parent = parentId === null ? '根目录' : (await provider.getNote(parentId, exec.signal))?.name ?? parentId
      await approveNoteMutation(ctx, exec, 'knowledge_note_move', `移动「${node.name}」到「${parent}」\n原版本：${node.version}，原目录：${node.parentId ?? '根目录'}`)
      await assertNoteUnchanged(provider, node, exec.signal)
      const moved = await provider.moveNote(node.id, parentId, exec.signal)
      return mutationResult(provider, 'moved', moved, codec.encode(agent.session.id, moved.id))
    },
  }
}

async function approveNoteMutation(ctx: RuntimeContextLike, exec: ToolRunContextLike, toolName: string, reason: string): Promise<void> {
  requestNoteConfirmation(exec, reason)
}

async function assertNoteUnchanged(provider: KnowledgeProvider, node: NoteNode, signal: AbortSignal): Promise<void> {
  const current = await provider.getNote(node.id, signal)
  if (!current || current.version !== node.version || current.name !== node.name || current.parentId !== node.parentId) throw new Error('确认期间笔记已变化，请重新读取并确认，未执行修改')
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

function updateOperation(value: unknown): 'rename' | 'replace_range' | 'replace_content' | 'append_content' {
  if (value !== 'rename' && value !== 'replace_range' && value !== 'replace_content' && value !== 'append_content') {
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
