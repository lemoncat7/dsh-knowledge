import { normalizeNoteName } from './notes/store.js'
import type { KnowledgeProvider } from './provider.js'
import type { NoteNode } from './notes/domain.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import type { RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { assertExplicitKnowledgeNoteRequest } from './tool-authorization.js'
import { readMountedKnowledge, type KnowledgeHandleCodec } from './retrieval.js'
import { optionalToolInteger, requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'
import { noteConfirmationTools, requestNoteConfirmation, renderNoteToolOutput } from './note-confirmation.js'
import { planNoteContentUpdate, type NoteMutationPreview } from './note-edit-plan.js'

const MAX_TOOL_NOTE_CONTENT = 200_000

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => renderNoteToolOutput(value),
} as const

/** Reads need no semantic grant. Session handles and explicit mutation consent remain independent. */
export function registerKnowledgeNoteTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  codec: KnowledgeNoteHandleCodec,
  knowledgeCodec: KnowledgeHandleCodec,
  register = (tool: ToolDefinitionLike) => ctx.tools.register(tool),
): void {
  register(listNotesTool(provider, codec))
  register(readNoteTool(provider, codec, knowledgeCodec))
  const confirmable = noteConfirmationTools(ctx, register)
  register(createNoteTool(provider, codec))
  register(confirmable(updateNoteTool(ctx, provider, codec, knowledgeCodec)))
  register(confirmable(moveNoteTool(ctx, provider, codec)))
  register(confirmable(deleteNoteTool(provider, codec)))
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
    description: 'Read a bounded chunk from an editable text or Markdown note using its exact session-bound handle from knowledge_note_list/search or an explicit @ note-document reference in the user message. An @ reference already identifies the selected note; do not replace it with a same-title search result. This never reads folders or binary attachments and does not authorize mutations. Use offset and maxChars to continue long notes.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string', description: 'Exact signed note handle returned by knowledge_note_list, knowledge_note_search, or an explicit @ note-document reference.' },
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

function createNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  const fields = {
    kind: { type: 'string', enum: ['document', 'folder'] },
    name: { type: 'string', maxLength: 255 },
    parentFolderHandle: { type: 'string', description: 'Exact signed destination folder handle. Omit for root.' },
    content: { type: 'string', maxLength: MAX_TOOL_NOTE_CONTENT, description: 'Initial Markdown for a document; omit for folders.' },
  }
  return {
    name: 'knowledge_note_create',
    description: 'Create NEW notes or folders immediately, without a confirmation round. Single creation uses kind/name/content/parentFolderHandle. For batch generation use ONLY items (1–20 items, total content at most 1,000,000 characters); parentIndex can point to an earlier folder item. Existing notes are never overwritten. Batch creation is sequential, not atomic: on failure it stops and returns confirmed creations and an unconfirmed item. Inspect the destination before retrying an unconfirmed item; never replay the whole batch. Editing, renaming, moving and deleting EXISTING notes require confirmation through their own operations.',
    parameters: { type: 'object', additionalProperties: false, properties: {
      ...fields,
      items: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, properties: {
        ...fields, parentIndex: { type: 'integer', minimum: 0, description: 'Zero-based index of an EARLIER folder in this batch, mutually exclusive with parentFolderHandle.' },
      }, required: ['kind', 'name'] } },
    } },
    output: textOutput,
    async execute(raw, exec): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools'), args = toolRecord(raw)
      const batch = args.items !== undefined
      if (batch && Object.keys(fields).some(key=>args[key] !== undefined)) throw new Error('items cannot be combined with single-create fields')
      const inputs = batch ? args.items : [args]
      if (!Array.isArray(inputs) || !inputs.length || inputs.length > 20) throw new Error('items must contain 1–20 entries')
      const plans: Array<{ kind:'document'|'folder'; name:string; content:string; parentId:string|null; parentIndex:number|undefined }> = []
      let total = 0
      // Validate every item and external destination before the first write.
      for (const [index, rawItem] of inputs.entries()) {
        const item = toolRecord(rawItem), kind = noteKind(item.kind), name = requiredToolString(item.name, 'name', 255)
        normalizeNoteName(kind === 'document' && !name.trim().toLowerCase().endsWith('.md') ? name+'.md' : name)
        const content = optionalContent(item.content, 'content') ?? ''
        if (kind === 'folder' && item.content !== undefined) throw new Error('content must be omitted for a folder')
        total += content.length
        if (total > 1_000_000) throw new Error('batch content exceeds 1,000,000 characters')
        const parentIndex = optionalToolInteger(item.parentIndex, 'parentIndex', 0, 19)
        if (parentIndex !== undefined && (!batch || item.parentFolderHandle !== undefined || parentIndex >= index || plans[parentIndex]?.kind !== 'folder')) throw new Error('parentIndex must reference an earlier folder and cannot coexist with parentFolderHandle')
        const parentId = parentIndex === undefined ? await resolveOptionalFolderId(provider, codec, agent.session.id, item.parentFolderHandle, 'parentFolderHandle', exec.signal) : null
        plans.push({ kind, name, content, parentId, parentIndex })
      }
      const nodes: NoteNode[] = []
      for (const [index, plan] of plans.entries()) {
        try {
          exec.signal.throwIfAborted()
          const parentId = plan.parentIndex === undefined ? plan.parentId : nodes[plan.parentIndex]!.id
          const node = plan.kind === 'folder' ? await provider.createNoteFolder(plan.name, parentId, exec.signal) : await provider.createNoteDocument(plan.name, parentId, plan.content, exec.signal)
          nodes.push(node)
        } catch (error) {
          if (!batch) throw error
          return JSON.stringify({ storage: provider.mode, operation: 'batch_create', status: 'incomplete', created: nodes.map((node,index)=>({ index, note: noteView(node,codec.encode(agent.session.id,node.id)) })),
            failed: { index, name: plan.name, outcome: 'unconfirmed', error: error instanceof Error ? error.message : String(error) },
            notAttempted: plans.slice(index+1).map((p,n)=>({index:index+1+n,name:p.name})),
            notice: '已确认创建的项目不要重放；失败项可能已被远端保存，先查询目标目录核实，再只处理剩余项目。没有自动回滚或覆盖已有内容。', })
        }
      }
      if (!batch) return mutationResult(provider, 'created', nodes[0]!, codec.encode(agent.session.id, nodes[0]!.id))
      return JSON.stringify({ storage: provider.mode, operation: 'batch_create', status: 'completed', created: nodes.map((node,index)=>({index,note:noteView(node,codec.encode(agent.session.id,node.id))})) })
    },
  }
}

function updateNoteTool(ctx: RuntimeContextLike, provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec, knowledgeCodec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_update',
    description: 'Propose ALL requested changes to one note together, with one before/after preview and ONE user confirmation. Read needed pages first and pass expectedVersion. Use batch_edit for multiple sections: all edits use the same original snapshot and are saved atomically. Use replace_content when the user requests a whole-document rewrite; do not split that request into chapter-by-chapter confirmations. Use replace_range for a single local change and append_content only for genuine additions. Show returned locations and before/after differences, not a bare confirmation request. Do not retry after rejection or write unchanged observations.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteHandle: { type: 'string', description: 'Exact signed handle returned by knowledge_note_list or knowledge_note_search.' },
        knowledgeHandle: { type: 'string', description: 'Mounted knowledge document referencing this note. Checked against current mounts and references on every call; partner heartbeat uses its dedicated recording tool.' },
        operation: { type: 'string', enum: ['rename', 'batch_edit', 'replace_range', 'replace_content', 'append_content'], description: 'batch_edit: combine all requested local edits/merges/deletions in one proposal, preserving untouched text. replace_content: requested whole-document restructuring/rewrite. Never append replacement sections or ask for one confirmation per section.' },
        oldText: { type: 'string', description: 'For replace_range: exact existing text copied from knowledge_note_read. Must match exactly once. value replaces only this text; all other characters are preserved by the server.' },
        edits: { type: 'array', minItems: 1, maxItems: 100, description: 'For batch_edit only. Collect every requested section here before calling once. Anchors refer to the SAME original version, must be unique, and may not overlap. Empty newText deletes that range.', items: {
          type: 'object', additionalProperties: false, properties: { oldText: { type: 'string' }, newText: { type: 'string' } }, required: ['oldText', 'newText'],
        } },
        summary: { type: 'string', description: 'Briefly describe how this complete set of changes addresses the user request; concrete before/after previews are generated by the server.' },
        expectedVersion: { type: 'integer', minimum: 1, description: 'For content updates, pass note.version from knowledge_note_read. A stale version is rejected; reread and merge instead of overwriting.' },
        value: { type: 'string', description: 'Required for operations other than batch_edit: new name or content. Omit for batch_edit and supply edits instead.' },
      },
      required: ['noteHandle', 'operation'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const handle = requiredToolString(args.noteHandle, 'noteHandle', 4096)
      const operation = updateOperation(args.operation)
      const purpose = optionalText(args.summary, 'summary', 1000)
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
        const snapshot = await provider.readNote(node.id, exec.signal)
        if (snapshot.node.version !== expectedVersion) throw new Error('笔记已变化，请重新读取并合并后更新')
        const original = decodeTextNote(snapshot.content)
        const plan = planNoteContentUpdate(original, operation, args)
        await approveNoteMutation(ctx, exec, 'knowledge_note_update', `${plan.summary}\n笔记：${node.name}\n版本：${expectedVersion}${purpose ? `\n本次修改目的：${purpose}` : ''}`, plan.preview)
        await assertNoteUnchanged(provider, node, exec.signal)
        updated = await provider.updateNoteContent(node.id, new TextEncoder().encode(plan.content), exec.signal, expectedVersion, 'AI 修改')
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

async function approveNoteMutation(ctx: RuntimeContextLike, exec: ToolRunContextLike, toolName: string, reason: string, preview?: NoteMutationPreview): Promise<void> {
  requestNoteConfirmation(exec, reason, preview)
}

async function assertNoteUnchanged(provider: KnowledgeProvider, node: NoteNode, signal: AbortSignal): Promise<void> {
  const current = await provider.getNote(node.id, signal)
  if (!current || current.version !== node.version || current.name !== node.name || current.parentId !== node.parentId) throw new Error('确认期间笔记已变化，请重新读取并确认，未执行修改')
}

function deleteNoteTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_delete',
    description: 'Propose permanent deletion of an existing note or folder. Shows the exact target and descendant list; requires later-turn user confirmation before deleting. Requires an exact signed handle. Referenced notes remain protected; remote deletion still requires an admin-capable token.',
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
      const snapshot = await deletionSnapshot(provider, node, exec.signal)
      await requestNoteConfirmation(exec, `永久删除「${node.name}」及包含的项目，共 ${snapshot.length} 项；不会自动恢复。`, {
        text: JSON.stringify(snapshot, null, 2), changeCount: snapshot.length, locations: [],
      })
      await assertNoteUnchanged(provider, node, exec.signal)
      if (JSON.stringify(await deletionSnapshot(provider, node, exec.signal)) !== JSON.stringify(snapshot)) throw new Error('确认期间目录内容已变化，请重新读取并确认；未删除')
      await provider.deleteNote(node.id, exec.signal)
      return JSON.stringify({ storage: provider.mode, operation: 'deleted', note: { name: node.name, kind: node.kind } }, null, 2)
    },
  }
}

async function deletionSnapshot(provider: KnowledgeProvider, root: NoteNode, signal: AbortSignal) {
  const nodes = [root]
  for (let index = 0; index < nodes.length; index++) {
    signal.throwIfAborted()
    if (nodes[index]!.kind === 'folder') nodes.push(...await provider.listNotes({parentId:nodes[index]!.id,limit:201},signal))
    if (nodes.length > 200) throw new Error('目录删除超过200项，请在管理页面核对范围后处理；未删除')
  }
  return nodes.sort((a,b)=>a.id.localeCompare(b.id)).map(n=>({id:n.id,name:n.name,kind:n.kind,parentId:n.parentId,version:n.version,sha256:n.sha256}))
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

function noteContent(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  if (value.length > MAX_TOOL_NOTE_CONTENT) throw new Error(`${name} must contain at most ${MAX_TOOL_NOTE_CONTENT} characters`)
  return value
}

function noteKind(value: unknown): 'document' | 'folder' {
  if (value !== 'document' && value !== 'folder') throw new Error('kind must be document or folder')
  return value
}

function updateOperation(value: unknown): 'rename' | 'batch_edit' | 'replace_range' | 'replace_content' | 'append_content' {
  if (value !== 'rename' && value !== 'batch_edit' && value !== 'replace_range' && value !== 'replace_content' && value !== 'append_content') {
    throw new Error('operation must be rename, batch_edit, replace_range, replace_content, or append_content')
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
