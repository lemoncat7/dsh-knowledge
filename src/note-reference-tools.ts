import type { KnowledgeProvider } from './provider.js'
import { readMountedKnowledge, type KnowledgeHandleCodec } from './retrieval.js'
import type { RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { KnowledgeNoteHandleCodec } from './note-reference-handle.js'
import { assertExplicitKnowledgeNoteReferenceRequest, assertExplicitKnowledgeNoteRequest } from './tool-authorization.js'
import { optionalToolInteger, requiredToolString, requireToolAgent, toolRecord } from './tool-input.js'

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
} as const

export function registerKnowledgeNoteReferenceTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  knowledgeCodec: KnowledgeHandleCodec,
  noteCodec: KnowledgeNoteHandleCodec,
): void {
  ctx.tools.register(searchNotesTool(provider, noteCodec))
  ctx.tools.register(manageNoteReferencesTool(provider, knowledgeCodec, noteCodec))
}

function searchNotesTool(provider: KnowledgeProvider, codec: KnowledgeNoteHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_note_search',
    description: 'Search note-document and editable-file metadata when the current user explicitly asks to inspect, edit, organize, or reference notes. This never reads note content. Pass exact returned handles to knowledge_note_read/update/move/delete or knowledge_note_references; never invent a handle.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'A focused note filename or title query.' },
        limit: { type: 'integer', description: 'Maximum results, default 10 and maximum 20.' },
      },
      required: ['query'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      assertExplicitKnowledgeNoteRequest(agent, 'inspect')
      const args = toolRecord(raw)
      const query = requiredToolString(args.query, 'query', 1000)
      const limit = optionalToolInteger(args.limit, 'limit', 1, 20) ?? 10
      const notes = await provider.searchNotes(query, limit, exec.signal)
      if (notes.length === 0) return `No note document matches ${JSON.stringify(query)}.`
      return [
        `${notes.length} note document(s) match ${JSON.stringify(query)} (metadata only):`,
        ...notes.map(note => `- ${note.name} (${note.kind === 'document' ? 'note document' : note.mediaType ?? 'file'}, handle: ${codec.encode(agent.session.id, note.id)})`),
      ].join('\n')
    },
  }
}

function manageNoteReferencesTool(
  provider: KnowledgeProvider,
  knowledgeCodec: KnowledgeHandleCodec,
  noteCodec: KnowledgeNoteHandleCodec,
): ToolDefinitionLike {
  return {
    name: 'knowledge_note_references',
    description: 'Inspect, add, or remove the structured note references of one knowledge document only when the current user explicitly asks. The knowledge handle must come from knowledge_search and note handles from knowledge_note_search or this tool. References are metadata relationships and never modify the Markdown body. Add/remove requires a currently writable mounted knowledge base and an open document.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        knowledgeHandle: { type: 'string', description: 'Exact signed knowledge handle returned by knowledge_search.' },
        operation: { type: 'string', enum: ['list', 'add', 'remove'] },
        noteHandles: { type: 'array', items: { type: 'string' }, maxItems: 16, description: 'Exact note handles. Required for add/remove; omitted for list.' },
      },
      required: ['knowledgeHandle', 'operation'],
    },
    output: textOutput,
    isConcurrencySafe: args => toolRecord(args).operation === 'list',
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireToolAgent(exec, 'knowledge note tools')
      const args = toolRecord(raw)
      const operation = parseOperation(args.operation)
      assertExplicitKnowledgeNoteReferenceRequest(agent, operation === 'list' ? 'inspect' : operation)
      const knowledgeHandle = requiredToolString(args.knowledgeHandle, 'knowledgeHandle', 4096)
      const { entry, mount } = await readMountedKnowledge(provider, agent, knowledgeHandle, knowledgeCodec, exec.signal)
      if (operation !== 'list' && mount.writeMode === 'none') {
        throw new Error('the knowledge document is mounted read-only in this session')
      }
      const noteHandles = parseNoteHandles(args.noteHandles, operation)
      const noteIds = [...new Set(noteHandles.map(handle => noteCodec.decode(handle, agent.session.id).noteId))]
      let changed = 0
      if (operation === 'add') {
        const before = new Set((await provider.listKnowledgeNoteReferences(entry.id, exec.signal)).map(reference => reference.note.id))
        for (const noteId of noteIds) {
          await provider.addKnowledgeNoteReference(entry.id, noteId, 'agent', agent.session.id, exec.signal)
          if (!before.has(noteId)) changed += 1
        }
      }
      if (operation === 'remove') {
        const current = new Set((await provider.listKnowledgeNoteReferences(entry.id, exec.signal)).map(reference => reference.note.id))
        for (const noteId of noteIds) {
          if (!current.has(noteId)) continue
          await provider.deleteKnowledgeNoteReference(entry.id, noteId, exec.signal)
          changed += 1
        }
      }
      const references = await provider.listKnowledgeNoteReferences(entry.id, exec.signal)
      return JSON.stringify({
        storage: provider.mode,
        operation,
        changed,
        knowledgeDocument: { id: entry.id, title: entry.title, knowledgeBaseId: entry.knowledgeBaseId },
        references: references.map(reference => ({
          name: reference.note.name,
          kind: reference.note.kind,
          mediaType: reference.note.mediaType,
          handle: noteCodec.encode(agent.session.id, reference.note.id),
        })),
      }, null, 2)
    },
  }
}

function parseOperation(value: unknown): 'list' | 'add' | 'remove' {
  if (value !== 'list' && value !== 'add' && value !== 'remove') throw new Error('operation must be list, add, or remove')
  return value
}

function parseNoteHandles(value: unknown, operation: 'list' | 'add' | 'remove'): string[] {
  if (operation === 'list') {
    if (value !== undefined) throw new Error('noteHandles must be omitted when operation is list')
    return []
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error('noteHandles must contain 1-16 signed handles for add/remove')
  }
  return value.map((handle, index) => requiredToolString(handle, `noteHandles[${index}]`, 4096))
}
