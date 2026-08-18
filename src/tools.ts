import type { KnowledgeProvider } from './provider.js'
import { normalizeTags, type KnowledgeBase, type KnowledgeBaseDraft, type KnowledgeBasePatch } from './domain.js'
import {
  formatKnowledgeEntry,
  formatSearchResults,
  KnowledgeHandleCodec,
  readMountedKnowledge,
  resolveRecallMounts,
  searchMountedKnowledge,
  selectMounts,
} from './retrieval.js'
import type { AgentLike, RuntimeContextLike, ToolDefinitionLike, ToolRunContextLike } from './runtime.js'

const textOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
} as const

/** Register scoped retrieval tools and explicit knowledge-base management tools. */
export function registerKnowledgeTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  codec: KnowledgeHandleCodec,
): void {
  ctx.tools.register(searchTool(provider, codec))
  ctx.tools.register(readTool(provider, codec))
  ctx.tools.register(createKnowledgeBaseTool(provider))
  ctx.tools.register(updateKnowledgeBaseTool(provider))
}

function createKnowledgeBaseTool(provider: KnowledgeProvider): ToolDefinitionLike {
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
        writebackProvider: { type: 'string', description: 'Optional dedicated write-back provider; must be supplied with writebackModel.' },
        writebackModel: { type: 'string', description: 'Optional dedicated write-back model; must be supplied with writebackProvider.' },
      },
      required: ['name'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      requireAgent(exec)
      const args = asRecord(raw)
      const writeback = parseWritebackRoute(args)
      const draft: KnowledgeBaseDraft = {
        name: requireNonEmptyString(args.name, 'name', 100),
        description: optionalTrimmedString(args.description, 'description', 2000) ?? '',
        defaultTags: normalizeTags(optionalStringArray(args.defaultTags, 'defaultTags', 32, 100)),
        extractionInstructions: optionalTrimmedString(args.extractionInstructions, 'extractionInstructions', 4000) ?? '',
        ...writeback,
      }
      const storage = provider.mode
      const base = await provider.createKnowledgeBase(draft, exec.signal)
      return formatKnowledgeBaseMutation(storage, 'created', base)
    },
  }
}

function updateKnowledgeBaseTool(provider: KnowledgeProvider): ToolDefinitionLike {
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
        writebackProvider: { type: 'string', description: 'Dedicated write-back provider; must be supplied with writebackModel.' },
        writebackModel: { type: 'string', description: 'Dedicated write-back model; must be supplied with writebackProvider.' },
        clearWritebackModel: { type: 'boolean', description: 'Clear the dedicated route and follow the current conversation model.' },
      },
      required: ['base'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      requireAgent(exec)
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
      const clearWritebackModel = optionalBoolean(args.clearWritebackModel, 'clearWritebackModel') ?? false
      if (clearWritebackModel && (args.writebackProvider !== undefined || args.writebackModel !== undefined)) {
        throw new Error('clearWritebackModel cannot be combined with writebackProvider or writebackModel')
      }
      if (clearWritebackModel) {
        patch.writebackProvider = null
        patch.writebackModel = null
      } else if (args.writebackProvider !== undefined || args.writebackModel !== undefined) {
        Object.assign(patch, parseWritebackRoute(args))
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
    description: 'Search only the knowledge bases mounted for recall in THIS session. Use this before answering from memory when the mounted-base catalog may cover the user\'s topic. Returns ranked snippets and signed opaque handles; call knowledge_read with an exact handle to open a result. Natural-language queries are supported. Never invent a handle.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'What to find. Prefer focused words from the current user request.' },
        base: { type: 'string', description: 'Optional exact mounted knowledge-base name or id. Omit to search all mounted bases.' },
        limit: { type: 'integer', description: 'Maximum ranked results, default 8 and maximum 20.' },
      },
      required: ['query'],
    },
    output: textOutput,
    isConcurrencySafe: () => true,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      const args = asRecord(raw)
      const query = requireNonEmptyString(args.query, 'query', 6000)
      const base = optionalString(args.base, 'base', 200)
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
    description: 'Read one approved knowledge section using the exact signed handle returned by knowledge_search or proactive retrieval. Handles are session-bound. Long sections are paginated; when a result says it was truncated, call again with the reported offset.',
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

function parseWritebackRoute(args: Record<string, unknown>): Pick<KnowledgeBaseDraft, 'writebackProvider' | 'writebackModel'> {
  const writebackProvider = optionalString(args.writebackProvider, 'writebackProvider', 100)
  const writebackModel = optionalString(args.writebackModel, 'writebackModel', 200)
  if ((writebackProvider === undefined) !== (writebackModel === undefined)) {
    throw new Error('writebackProvider and writebackModel must be supplied together')
  }
  return writebackProvider === undefined || writebackModel === undefined ? {} : { writebackProvider, writebackModel }
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

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`)
  return value
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
