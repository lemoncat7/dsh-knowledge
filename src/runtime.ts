import { randomUUID } from 'node:crypto'

export interface TextBlockLike { type: string; text?: string }

export interface MessageLike {
  id: string
  role: string
  content: TextBlockLike[]
  source: { kind: string; provider?: string; model?: string; plugin?: string; form?: string; summary?: string }
}

export interface SessionEventLike {
  type: string
  seq: number
  data: Record<string, unknown>
}

export interface SessionLike {
  id: string
  header: { cwd?: string }
  events: readonly SessionEventLike[]
  append?(type: 'user/message', data: MessageLike, options: { surfaceOp: 'append' }): SessionEventLike
}

export interface AgentLike {
  session: SessionLike
}

export interface ToolRunContextLike {
  agent?: AgentLike
  signal: AbortSignal
}

export interface ToolDefinitionLike {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): TextBlockLike[]
  }
  execute(args: unknown, exec: ToolRunContextLike): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
}

export interface ToolRuntimeLike {
  register(definition: ToolDefinitionLike): () => void
}

export interface PromptAssemblyLike {
  sections: Array<{ name: string; text: string }>
  contexts: Array<{ name: string; text: string }>
  tools: unknown[]
  variables: Record<string, string | undefined>
}

export interface AssembleContextLike {
  agent?: AgentLike
  signal?: AbortSignal
}

export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: MessageLike[] }

export interface PreStepPayload {
  agent: AgentLike
  messages: MessageLike[]
  turn: number
  step: number
  signal: AbortSignal
}

export type StreamChunkLike =
  | { type: 'text-delta'; text: string }
  | { type: 'block-end'; block: TextBlockLike }
  | { type: 'finish'; reason: { kind: string; failure?: { message?: string; code?: string } } }
  | { type: string }

export interface GenerateOptionsLike {
  provider: string
  model: string
  messages: MessageLike[]
  system?: string
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  signal?: AbortSignal
  sessionId?: string
}

export interface LlmLike {
  stream(options: GenerateOptionsLike): AsyncIterable<StreamChunkLike>
}

export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void | Promise<void>
  }): () => void
}

export interface RuntimeContextLike {
  llm: LlmLike
  tools: ToolRuntimeLike
  webServer?: WebServerLike
  settings?: {
    register(namespace: string, schema: unknown, options?: { base?: object }): unknown
  }
  logger: {
    debug(message: unknown): void
    info(message: unknown): void
    warn(message: unknown): void
    error(message: unknown): void
  }
  on(name: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): () => void
  on(name: 'agent/pre-step', listener: (
    payload: PreStepPayload,
    next: () => Promise<PreStepDecision>,
  ) => Promise<PreStepDecision>): () => void
  on(name: 'agent/turn-stopping', listener: (payload: {
    agent: AgentLike
    turn: number
    signal: AbortSignal
  }) => void | Promise<void>): () => void
  on(name: 'system-prompt/assemble', listener: (
    assembly: PromptAssemblyLike,
    context: AssembleContextLike,
    next: () => Promise<PromptAssemblyLike>,
  ) => Promise<PromptAssemblyLike>): () => void
  effect(factory: () => (() => void | Promise<void>), label?: string): void
  inject?(services: string[], callback: (ctx: RuntimeContextLike) => void): unknown
  get(name: string): unknown
}

export function messageText(message: MessageLike): string {
  return message.content
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text ?? '')
    .join('\n')
    .trim()
}

export function createRecallMessage(text: string): MessageLike {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-knowledge', form: 'recall' },
  }
}

export function createWritebackMessage(summary: string): MessageLike {
  const bounded = summary.trim().slice(0, 120)
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: bounded }],
    source: { kind: 'plugin', plugin: 'dsh-knowledge', form: 'notice', summary: bounded },
  }
}
