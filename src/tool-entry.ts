import { Ajv } from 'ajv'
import type { ToolDefinitionLike } from './runtime.js'

export const KNOWLEDGE_ENTRY = 'knowledge'
export const KNOWLEDGE_ENTRY_GUIDE = 'Knowledge and note operations use ONE tool: knowledge. Use action=list for the operation catalog, action=describe with tool=<operation> for its full parameters, then action=call with tool=<operation> and arguments={...}. All knowledge_* names in instructions, references and historical messages are operation names, NOT standalone tools. Prefer knowledge_base_search → knowledge_search → knowledge_read for mounted knowledge; knowledge_note_list/search/read for notes. Discovering an operation does not grant write access. Existing scopes, review and later-turn note confirmation still apply.'

/** Private dispatch only: never manufacture a nested host call or approval identity. */
export function knowledgeEntry(definitions: ReadonlyMap<string, ToolDefinitionLike>): ToolDefinitionLike {
  const operations = new Map(definitions)
  // Compile once, without coercion/default insertion or stripping extra fields.
  // Internal schemas retain bounds unsupported by the host's smaller schema DSL.
  const validator = new Ajv({ allErrors: true, strict: true, ownProperties: true })
  const validators = new Map([...operations].map(([name, tool]) => [name, validator.compile(tool.parameters)]))
  for (const operation of operations.values()) {
    if (operation.name === KNOWLEDGE_ENTRY) throw new Error('Recursive knowledge entry is not allowed')
  }
  const parameters: Record<string, unknown> = {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: ['list', 'describe', 'call'] },
      tool: { type: 'string', description: 'Exact operation name from list; required for describe and call.' },
      arguments: { type: 'object', additionalProperties: true, description: 'Parameters from describe, only for action=call.' },
    },
    required: ['action'],
  }
  const validateEntry = validator.compile(parameters)
  return {
    name: KNOWLEDGE_ENTRY,
    description: KNOWLEDGE_ENTRY_GUIDE,
    parameters,
    output: {
      schema: { type: 'string' },
      render(raw, value) {
        const args = raw as { action?: string; tool?: string; arguments?: unknown } | undefined
        const operation = args?.action === 'call' && args.tool ? operations.get(args.tool) : undefined
        // Preserve rich note previews and all existing output formatting.
        return operation ? operation.output.render(args?.arguments ?? {}, value) : [{ type: 'text', text: String(value) }]
      },
    },
    // Serialize calls conservatively, including preview/confirm state changes.
    isConcurrencySafe: raw => {
      const args = raw as { action?: string } | null
      return args?.action === 'list' || args?.action === 'describe'
    },
    async execute(raw, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new Error('knowledge requires an owning DSH session')
      if (!validateEntry(raw)) throw new Error(validator.errorsText(validateEntry.errors))
      const args = raw as { action: string; tool?: string; arguments?: Record<string, unknown> }
      if (args.action !== 'call' && args.arguments !== undefined) throw new Error('arguments is only accepted for action=call')
      if (args.action === 'list') {
        if (args.tool !== undefined) throw new Error('tool is only accepted for describe/call')
        // Public operation metadata only: no provider I/O, document names or handles.
        return JSON.stringify({ operations: [...operations.values()].map(tool => ({ name: tool.name, summary: tool.description.split(/\.\s/)[0] })), next: 'describe one operation, then call it. Availability is not authorization; scope and permissions are checked at execution.' })
      }
      const operation = args.tool && operations.get(args.tool)
      if (!operation) throw new Error('Unknown knowledge operation; use action=list first')
      if (args.action === 'describe') return JSON.stringify({ name: operation.name, description: operation.description, parameters: operation.parameters })
      const input = args.arguments ?? {}
      const validate = validators.get(operation.name)!
      if (!validate(input)) throw new Error(`${operation.name}: ${validator.errorsText(validate.errors)}`)
      // Same agent, cancellation and original business implementation: mounts,
      // session handles, versions, remote credentials, review and consent remain live.
      return operation.execute(input, exec)
    },
  }
}
