import type { KnowledgeProvider } from './provider.js'
import {
  normalizeTags,
  type KnowledgeBase,
  type KnowledgeBaseDraft,
  type KnowledgeBasePatch,
} from './domain.js'
import {
  formatKnowledgeEntry,
  formatKnowledgeBaseMatches,
  formatSearchResults,
  KnowledgeHandleCodec,
  readMountedKnowledge,
  resolveRecallMounts,
  searchMountedKnowledgeBases,
  searchMountedKnowledge,
  selectMounts,
} from './retrieval.js'
import { assertExplicitKnowledgeBaseManagementRequest } from './tool-authorization.js'
import type { AgentLike, LlmLike, RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'
import { registerKnowledgeNoteReferenceTools } from './note-reference-tools.js'
import { registerKnowledgeNoteTools } from './note-tools.js'
import type { KnowledgeNoteHandleCodec } from './note-reference-handle.js'

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
} as const

/** Register scoped retrieval tools and explicit knowledge-base management tools. */
export function registerKnowledgeTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  codec: KnowledgeHandleCodec,
  noteCodec: KnowledgeNoteHandleCodec,
): void {
  ctx.tools.register(searchKnowledgeBaseTool(provider))
  ctx.tools.register(searchTool(provider, codec))
  ctx.tools.register(readTool(provider, codec))
  ctx.tools.register(createKnowledgeBaseTool(provider, ctx.llm))
  ctx.tools.register(updateKnowledgeBaseTool(provider, ctx.llm))
  registerKnowledgeNoteTools(ctx, provider, noteCodec)
  registerKnowledgeNoteReferenceTools(ctx, provider, codec, noteCodec)
}

function searchKnowledgeBaseTool(provider: KnowledgeProvider): ToolDefinitionLike {
  return {
    name: 'knowledge_base_search',
    description: 'First-stage knowledge discovery and the preferred first lookup for the user\'s projects, preferences, prior decisions, workflows, installed tools, or mounted topics. Search only knowledge bases mounted for recall in THIS session by their name, routing description, and tags. Call this before workspace-file or web discovery when durable user-managed knowledge may apply, then use knowledge_search. It returns metadata only, never knowledge document content. If nothing matches, continue to the next appropriate source.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'A concise description of the current topic or information need.' },
        limit: { type: 'integer', description: 'Maximum matching knowledge bases, default 5 and maximum 10.' },
      },
      required: ['query'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      const args = asRecord(raw)
      const query = requireNonEmptyString(args.query, 'query', 2000)
      const limit = optionalInteger(args.limit, 'limit', 1, 10) ?? 5
      const mounts = await resolveRecallMounts(provider, agent, exec.signal)
      if (mounts.length === 0) return 'No knowledge bases are mounted for recall in this session.'
      return formatKnowledgeBaseMatches(query, searchMountedKnowledgeBases(mounts, query, limit))
    },
  }
}

function createKnowledgeBaseTool(provider: KnowledgeProvider, llm: LlmLike): ToolDefinitionLike {
  return {
    name: 'knowledge_base_create',
    description: 'Create a knowledge base only when the user explicitly asks. The tool always uses the currently active knowledge provider and reports whether it created the base in local or remote storage; it never guesses, falls back, copies, or synchronizes. Creating a base does not mount it to the current project or session.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Knowledge-base name, 1-100 characters.' },
        description: { type: 'string', description: 'Routing description used to decide whether conversations belong in this base, at most 2000 characters.' },
        defaultTags: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        extractionInstructions: { type: 'string', description: 'Additional write-back rules, at most 4000 characters.' },
        writebackPolicy: { type: 'string', enum: ['conservative', 'proactive'], description: 'Write-back strictness; defaults to conservative.' },
        writebackProvider: { type: 'string', description: 'Optional dedicated write-back provider. Must be supplied together with writebackModel.' },
        writebackModel: { type: 'string', description: 'Optional dedicated write-back model. Must be supplied together with writebackProvider.' },
      },
      required: ['name'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      assertExplicitKnowledgeBaseManagementRequest(agent, 'create')
      const args = asRecord(raw)
      const writebackProvider = optionalString(args.writebackProvider, 'writebackProvider', 100)
      const writebackModel = optionalString(args.writebackModel, 'writebackModel', 200)
      if ((writebackProvider === undefined) !== (writebackModel === undefined)) {
        throw new Error('writebackProvider and writebackModel must be configured together')
      }
      if (writebackProvider !== undefined && writebackModel !== undefined) {
        await validateWritebackRoute(llm, writebackProvider, writebackModel, exec.signal)
      }
      const draft: KnowledgeBaseDraft = {
        name: requireNonEmptyString(args.name, 'name', 100),
        description: optionalTrimmedString(args.description, 'description', 2000) ?? '',
        defaultTags: normalizeTags(optionalStringArray(args.defaultTags, 'defaultTags', 32, 100)),
        extractionInstructions: optionalTrimmedString(args.extractionInstructions, 'extractionInstructions', 4000) ?? '',
        writebackPolicy: parseWritebackPolicy(args.writebackPolicy) ?? 'conservative',
        ...writebackProvider === undefined || writebackModel === undefined ? {} : { writebackProvider, writebackModel },
      }
      const storage = provider.mode
      const base = await provider.createKnowledgeBase(draft, exec.signal)
      return formatKnowledgeBaseMutation(storage, 'created', base)
    },
  }
}

function updateKnowledgeBaseTool(provider: KnowledgeProvider, llm: LlmLike): ToolDefinitionLike {
  return {
    name: 'knowledge_base_update',
    description: 'Modify an existing knowledge base only when the user explicitly asks. Identify it by exact id or name. The tool always updates the currently active local or remote provider and reports the actual destination; it never moves or synchronizes the base and does not change project/session mounts.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        base: { type: 'string', description: 'Exact knowledge-base id or name.' },
        name: { type: 'string', description: 'New name, 1-100 characters.' },
        description: { type: 'string', description: 'New routing description; an empty string clears it.' },
        defaultTags: { type: 'array', items: { type: 'string' }, maxItems: 32, description: 'Replacement default-tag list.' },
        extractionInstructions: { type: 'string', description: 'New write-back rules; an empty string clears them.' },
        writebackPolicy: { type: 'string', enum: ['conservative', 'proactive'], description: 'Replacement write-back strictness.' },
        writebackProvider: { type: 'string', description: 'Replacement dedicated provider. Must be supplied together with writebackModel.' },
        writebackModel: { type: 'string', description: 'Replacement dedicated model. Must be supplied together with writebackProvider.' },
        useCurrentSessionModel: { type: 'boolean', description: 'Set true to clear the dedicated model and follow each current conversation model.' },
      },
      required: ['base'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      assertExplicitKnowledgeBaseManagementRequest(agent, 'update')
      const args = asRecord(raw)
      const requestedBase = requireNonEmptyString(args.base, 'base', 200)
      const storage = provider.mode
      const base = await resolveKnowledgeBase(provider, requestedBase, exec.signal)
      const patch: KnowledgeBasePatch = {}
      if (args.name !== undefined) patch.name = requireNonEmptyString(args.name, 'name', 100)
      if (args.description !== undefined) patch.description = optionalTrimmedString(args.description, 'description', 2000) as string
      if (args.defaultTags !== undefined) patch.defaultTags = normalizeTags(optionalStringArray(args.defaultTags, 'defaultTags', 32, 100))
      if (args.extractionInstructions !== undefined) {
        patch.extractionInstructions = optionalTrimmedString(args.extractionInstructions, 'extractionInstructions', 4000) as string
      }
      const writebackPolicy = parseWritebackPolicy(args.writebackPolicy)
      if (writebackPolicy !== undefined) patch.writebackPolicy = writebackPolicy
      const writebackProvider = optionalString(args.writebackProvider, 'writebackProvider', 100)
      const writebackModel = optionalString(args.writebackModel, 'writebackModel', 200)
      if ((writebackProvider === undefined) !== (writebackModel === undefined)) {
        throw new Error('writebackProvider and writebackModel must be configured together')
      }
      if (args.useCurrentSessionModel !== undefined && typeof args.useCurrentSessionModel !== 'boolean') {
        throw new Error('useCurrentSessionModel must be a boolean')
      }
      if (args.useCurrentSessionModel === true && writebackProvider !== undefined) {
        throw new Error('useCurrentSessionModel cannot be combined with a dedicated write-back model')
      }
      if (args.useCurrentSessionModel === true) {
        patch.writebackProvider = null
        patch.writebackModel = null
      } else if (writebackProvider !== undefined && writebackModel !== undefined) {
        await validateWritebackRoute(llm, writebackProvider, writebackModel, exec.signal)
        patch.writebackProvider = writebackProvider
        patch.writebackModel = writebackModel
      }
      if (Object.keys(patch).length === 0) throw new Error('knowledge_base_update requires at least one field to modify')
      if (provider.mode !== storage) throw new Error('the active knowledge storage changed while resolving the base; retry the update')
      const updated = await provider.patchKnowledgeBase(base.id, patch, exec.signal)
      return formatKnowledgeBaseMutation(storage, 'updated', updated)
    },
  }
}

function searchTool(provider: KnowledgeProvider, codec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_search',
    description: 'Second-stage knowledge retrieval. Search one exact knowledge base returned by knowledge_base_search. The base must still be mounted for recall in THIS session. Returns ranked snippets and signed opaque handles; call knowledge_read with an exact handle to open a result. Never invent a base id or handle.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to find. Prefer focused words from the current user request.' },
        base: { type: 'string', description: 'Exact mounted knowledge-base id or name returned by knowledge_base_search.' },
        limit: { type: 'integer', description: 'Maximum ranked results, default 8 and maximum 20.' },
      },
      required: ['query', 'base'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      const args = asRecord(raw)
      const query = requireNonEmptyString(args.query, 'query', 6000)
      const base = requireNonEmptyString(args.base, 'base', 200)
      const limit = optionalInteger(args.limit, 'limit', 1, 20) ?? 8
      const mounts = selectMounts(await resolveRecallMounts(provider, agent, exec.signal), base)
      if (mounts.length === 0) return 'No knowledge bases are mounted for recall in this session.'
      const hits = await searchMountedKnowledge(provider, agent, mounts, query, limit, codec, exec.signal)
      return formatSearchResults(query, hits)
    },
  }
}

function readTool(provider: KnowledgeProvider, codec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_read',
    description: 'Read one approved knowledge document using the exact signed handle returned by knowledge_search. Handles are session-bound. Long documents are paginated; when a result says it was truncated, call again with the reported offset.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'string', description: 'Exact opaque handle returned by knowledge_search. Do not reconstruct it.' },
        offset: { type: 'integer', description: 'Character offset for continuing a long section; default 0.' },
        maxChars: { type: 'integer', description: 'Characters to return, default 12000 and maximum 20000.' },
      },
      required: ['handle'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      const args = asRecord(raw)
      const handle = requireNonEmptyString(args.handle, 'handle', 4096)
      const offset = optionalInteger(args.offset, 'offset', 0, 1_000_000) ?? 0
      const maxChars = optionalInteger(args.maxChars, 'maxChars', 500, 20_000) ?? 12_000
      const { entry, mount } = await readMountedKnowledge(provider, agent, handle, codec, exec.signal)
      return formatKnowledgeEntry(entry, mount, offset, maxChars)
    },
  }
}

function parseWritebackPolicy(value: unknown): KnowledgeBaseDraft['writebackPolicy'] | undefined {
  if (value === undefined) return undefined
  if (value !== 'conservative' && value !== 'proactive') {
    throw new Error('writebackPolicy must be conservative or proactive')
  }
  return value
}

async function resolveKnowledgeBase(
  provider: KnowledgeProvider,
  requested: string,
  signal?: AbortSignal,
): Promise<KnowledgeBase> {
  const folded = requested.toLocaleLowerCase('zh-CN')
  const matches = (await provider.listKnowledgeBases(signal)).filter(base => base.id === requested
    || base.name.toLocaleLowerCase('zh-CN') === folded)
  if (matches.length === 0) throw new Error(`knowledge base ${JSON.stringify(requested)} was not found in the active ${provider.mode} storage`)
  if (matches.length > 1) throw new Error(`knowledge base ${JSON.stringify(requested)} is ambiguous; use its exact id`)
  return matches[0] as KnowledgeBase
}

async function validateWritebackRoute(
  llm: LlmLike,
  provider: string,
  model: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    await llm.resolveModelInfo(provider, model, signal)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`write-back model ${provider}/${model} is unavailable: ${detail}`)
  }
}

function formatKnowledgeBaseMutation(
  storage: KnowledgeProvider['mode'],
  operation: 'created' | 'updated',
  base: KnowledgeBase,
): string {
  return JSON.stringify({
    storage,
    operation,
    knowledgeBase: base,
    mountsChanged: false,
    note: storage === 'remote'
      ? 'The central knowledge service was modified. No local copy was created or synchronized.'
      : 'The current DSH local knowledge database was modified. No remote copy was created or synchronized.',
  }, null, 2)
}

function requireAgent(exec: ToolRunContextLike): AgentLike {
  if (exec.agent === undefined) throw new Error('knowledge tools require a calling DSH agent')
  return exec.agent
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('tool arguments must be an object')
  return value as Record<string, unknown>
}

function requireNonEmptyString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${name} must contain at most ${maxLength} characters`)
  return result
}

function optionalString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  return requireNonEmptyString(value, name, maxLength)
}

function optionalInteger(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`)
  }
  return Number(value)
}

function optionalTrimmedString(value: unknown, name: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`${name} must be a string`)
  const result = value.trim()
  if (result.length > maxLength) throw new Error(`${name} must contain at most ${maxLength} characters`)
  return result
}

function optionalStringArray(
  value: unknown,
  name: string,
  maxItems: number,
  maxLength: number,
): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`${name} must be an array with at most ${maxItems} items`)
  return value.map((item, index) => requireNonEmptyString(item, `${name}[${index}]`, maxLength))
}
