import type { KnowledgeProvider } from './provider.js'
import type { AgentLike } from './runtime.js'
import type { RecallUsage } from './recall-ranking.js'

let inFlight = 0
/** Capture the provider before retrieval so a connection switch cannot cross-write usage. */
export function usageRecorder(provider: KnowledgeProvider, agent: AgentLike, explicitTurn?: number) {
  const record = provider.recordRecallUsage?.bind(provider)
  const events = explicitTurn === undefined ? agent.session.snapshotEvents?.() || [] : []
  const turn = explicitTurn ?? [...events].reverse().find(event => event.type === 'turn/start')?.data.turn
  // A missing turn identifier is conservatively counted once per session, not per page/call.
  const value = { sessionId: agent.session.id, turn: String(turn ?? 'unknown'), ...(agent.session.header.cwd ? { projectId: agent.session.header.cwd } : {}) }
  return (kind: RecallUsage['kind'], ids: string[]) => {
    if (!record || !ids.length || inFlight >= 64) return
    inFlight++
    try {
      // Never await optional telemetry on the answer path. Older servers may reject it.
      void record({ ...value, kind, ids: [...new Set(ids)].slice(0, 20) }, AbortSignal.timeout(2500)).catch(() => {}).finally(() => { inFlight-- })
    } catch { inFlight-- }
  }
}
