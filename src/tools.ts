import type { KnowledgeProvider } from './provider.js'
import {
  isKnowledgeType,
  normalizeTags,
  type CandidateProposal,
  type KnowledgeBase,
  type KnowledgeBaseDraft,
  type KnowledgeBasePatch,
  type KnowledgeDraft,
  type ResolvedKnowledgeMount,
} from './domain.js'
import {
  formatKnowledgeEntry,
  formatKnowledgeBaseMatches,
  formatSearchResults,
  KnowledgeHandleCodec,
  readMountedKnowledge,
  resolveKnowledgeMounts,
  resolveRecallMounts,
  searchMountedKnowledgeBases,
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
  ctx.tools.register(searchKnowledgeBaseTool(provider))
  ctx.tools.register(searchTool(provider, codec))
  ctx.tools.register(readTool(provider, codec))
  ctx.tools.register(createKnowledgeBaseTool(provider))
  ctx.tools.register(updateKnowledgeBaseTool(provider))
}

function writeTool(provider: KnowledgeProvider, codec: KnowledgeHandleCodec): ToolDefinitionLike {
  return {
    name: 'knowledge_write',
    description: 'Use ONLY when the current direct user message explicitly asks to save, remember, record, or write content into a knowledge base. Normal durable findings are handled automatically after the answer and MUST NOT trigger this tool. Persist explicit requests as topic documents in a writable mounted base. Search first and pass the matching document handle; send only new Markdown material. Never mention this tool, its result, automatic write-back, or any write refusal in the assistant answer.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        handle: { type: 'string', description: 'For an update: exact signed handle returned by knowledge_search.' },
        base: { type: 'string', description: 'For a new document: exact writable mounted knowledge-base id or name. Optional only when exactly one writable base is mounted.' },
        title: { type: 'string', description: 'Stable subject document title, not an individual fact title. For a GitHub repository prefer owner/repository. Required only for a genuinely new document.' },
        content: { type: 'string', description: 'Only the NEW Markdown sections or paragraphs for the topic document. Group related findings, and do not repeat existing content or include session narration.' },
        type: { type: 'string', enum: ['preference', 'fact', 'decision', 'procedure', 'lesson'], description: 'Knowledge type. Required for new knowledge; existing type is preserved on update.' },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 32 },
        scope: { type: 'string', enum: ['global', 'project'], description: 'Scope for new knowledge. Project uses the current workspace; default is global.' },
      },
      required: ['content'],
    },
    output: textOutput,
    isConcurrencySafe: () => false,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      const agent = requireAgent(exec)
      if (!currentUserExplicitlyRequestsKnowledgeWrite(agent)) {
        return JSON.stringify({
          outcome: 'not-needed',
          instruction: 'Continue the substantive answer silently. Do not mention knowledge_write, this result, automatic write-back, persistence, or any refusal in the assistant answer.',
        })
      }
      const args = asRecord(raw)
      const content = requireNonEmptyString(args.content, 'content', 50_000)
      const handle = optionalString(args.handle, 'handle', 4096)
      const allMounts = await resolveKnowledgeMounts(provider, agent, exec.signal)
      const writableMounts = allMounts.filter(mount => mount.writeMode !== 'none')
      if (writableMounts.length === 0) throw new Error('no writable knowledge base is mounted in this session')

      let mount: ResolvedKnowledgeMount
      let targetId: string | undefined
      let current: Awaited<ReturnType<KnowledgeProvider['get']>> = undefined
      if (handle !== undefined) {
        const resolved = await readMountedKnowledge(provider, agent, handle, codec, exec.signal)
        mount = resolved.mount
        current = resolved.entry
        targetId = resolved.entry.id
        if (mount.writeMode === 'none') throw new Error('the knowledge base addressed by this handle is mounted read-only')
      } else {
        mount = selectWritableMount(writableMounts, optionalString(args.base, 'base', 200))
      }

      const scope = current?.scope ?? parseWriteScope(args.scope, agent.session.header.cwd)
      const type = current?.type ?? parseWriteType(args.type)
      const title = current?.title ?? requireNonEmptyString(args.title, 'title', 200)
      const turn = currentTurn(agent)
      const draft: KnowledgeDraft = {
        knowledgeBaseId: mount.knowledgeBaseId,
        title,
        body: content,
        type,
        tags: normalizeTags([
          ...mount.base.defaultTags,
          ...mount.includeTags,
          ...optionalStringArray(args.tags, 'tags', 32, 100),
        ]).filter(tag => !mount.excludeTags.includes(tag)),
        scope,
        confidence: .95,
        source: {
          sessionId: agent.session.id,
          ...turn === undefined ? {} : { turn },
        },
      }
      const proposal: CandidateProposal = {
        action: targetId === undefined ? 'create' : 'update',
        ...targetId === undefined ? {} : { targetId },
        draft,
        reason: 'Persisted through the scoped knowledge_write tool.',
      }
      const sourceKey = `knowledge-write:${agent.session.id}`
      if (mount.writeMode === 'audit') {
        const candidate = await provider.propose(proposal, sourceKey, exec.signal)
        return JSON.stringify({
          storage: provider.mode,
          outcome: 'pending-review',
          knowledgeBase: { id: mount.knowledgeBaseId, name: mount.base.name },
          candidateId: candidate.id,
        }, null, 2)
      }
      const result = await provider.writeDirect(proposal, sourceKey, exec.signal)
      return JSON.stringify({
        storage: provider.mode,
        outcome: result.outcome,
        knowledgeBase: { id: mount.knowledgeBaseId, name: mount.base.name },
        ...result.entry === undefined ? {} : { document: { id: result.entry.id, title: result.entry.title } },
        ...result.candidate?.status === 'pending' ? { candidateId: result.candidate.id } : {},
      }, null, 2)
    },
  }
}

function currentUserExplicitlyRequestsKnowledgeWrite(agent: AgentLike): boolean {
  let turnStart = -1
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    if (agent.session.events[index]?.type === 'turn/start') { turnStart = index; break }
  }
  const text = agent.session.events.slice(turnStart + 1)
    .filter(event => event.type === 'user/message')
    .map(event => event.data as unknown as { source?: { kind?: string }; content?: Array<{ type?: string; text?: string }> })
    .filter(message => message.source?.kind === 'user')
    .flatMap(message => message.content ?? [])
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
  if (text.length === 0) return false
  if (/(?:不要|别|无需|不需要|禁止|取消).{0,12}(?:写入|回写|存入|保存|收录|记录|记住|加入|添加|沉淀).{0,12}知识库/iu.test(text)) return false
  if (/(?:do\s+not|don't|never|no\s+need\s+to).{0,24}(?:write|save|store|record|remember|add|persist).{0,24}(?:knowledge|memory)/iu.test(text)) return false
  return /(?:请|麻烦|帮我|把|将).{0,80}(?:写入|回写|存入|保存到|保存进|收录到|记录到|记到|加入|添加到|沉淀到).{0,40}知识库/iu.test(text)
    || /(?:请|麻烦|帮我).{0,20}(?:记住|记下来|记录下来|保存下来)(?:这|该|上述|以上|当前|刚才|它|内容|结论|信息)/iu.test(text)
    || /(?:please\s+)?(?:write|save|store|record|remember|add|persist).{0,60}(?:to|in|into)?\s*(?:the\s+)?(?:knowledge\s*(?:base|store)|memory)/iu.test(text)
}

function searchKnowledgeBaseTool(provider: KnowledgeProvider): ToolDefinitionLike {
  return {
    name: 'knowledge_base_search',
    description: 'First-stage knowledge discovery. Search only knowledge bases mounted for recall in THIS session by their name, routing description, and tags. Call this before knowledge_search when the current request may depend on durable project or user knowledge. It returns metadata only, never knowledge document content. If nothing matches, continue without knowledge retrieval.',
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
      },
      required: ['name'],
    },
    output: textOutput,
    async execute(raw: unknown, exec: ToolRunContextLike): Promise<string> {
      requireAgent(exec)
      const args = asRecord(raw)
      const draft: KnowledgeBaseDraft = {
        name: requireNonEmptyString(args.name, 'name', 100),
        description: optionalTrimmedString(args.description, 'description', 2000) ?? '',
        defaultTags: normalizeTags(optionalStringArray(args.defaultTags, 'defaultTags', 32, 100)),
        extractionInstructions: optionalTrimmedString(args.extractionInstructions, 'extractionInstructions', 4000) ?? '',
        writebackPolicy: 'conservative',
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

function selectWritableMount(
  mounts: ResolvedKnowledgeMount[],
  requested?: string,
): ResolvedKnowledgeMount {
  if (requested === undefined) {
    if (mounts.length === 1) return mounts[0] as ResolvedKnowledgeMount
    throw new Error(`multiple writable knowledge bases are mounted (${mounts.map(mount => mount.base.name).join(', ')}); specify one with base`)
  }
  const folded = requested.toLocaleLowerCase('zh-CN')
  const matches = mounts.filter(mount => mount.knowledgeBaseId === requested
    || mount.base.name.toLocaleLowerCase('zh-CN') === folded)
  if (matches.length === 0) throw new Error(`knowledge base ${JSON.stringify(requested)} is not mounted for write-back`)
  if (matches.length > 1) throw new Error(`knowledge base ${JSON.stringify(requested)} is ambiguous; use its exact id`)
  return matches[0] as ResolvedKnowledgeMount
}

function parseWriteScope(value: unknown, projectId?: string): KnowledgeDraft['scope'] {
  if (value === undefined || value === 'global') return { kind: 'global' }
  if (value !== 'project') throw new Error('scope must be global or project')
  if (projectId === undefined || projectId.trim().length === 0) {
    throw new Error('project scope requires a current workspace')
  }
  return { kind: 'project', id: projectId }
}

function parseWriteType(value: unknown): KnowledgeDraft['type'] {
  if (!isKnowledgeType(value)) throw new Error('type is required for new knowledge and must be preference, fact, decision, procedure, or lesson')
  return value
}

function currentTurn(agent: AgentLike): number | undefined {
  for (let index = agent.session.events.length - 1; index >= 0; index -= 1) {
    const event = agent.session.events[index]
    if (event?.type === 'turn/start' && typeof event.data.turn === 'number') return event.data.turn
  }
  return undefined
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
