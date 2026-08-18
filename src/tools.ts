import type { KnowledgeProvider } from './provider.js'
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

/** Register read-only retrieval tools. Their effective base scope is resolved from the calling Agent. */
export function registerKnowledgeTools(
  ctx: RuntimeContextLike,
  provider: KnowledgeProvider,
  codec: KnowledgeHandleCodec,
): void {
  ctx.tools.register(searchTool(provider, codec))
  ctx.tools.register(readTool(provider, codec))
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
