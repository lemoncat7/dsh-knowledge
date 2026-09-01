import type { KnowledgeProvider } from './provider.js'

interface ProviderState {
  provider: KnowledgeProvider
  owned: boolean
  active: number
  retired: boolean
  closePromise?: Promise<void>
  idlePromise?: Promise<void>
  resolveIdle?: () => void
}

/**
 * Stable provider identity for runtime consumers while settings switch the
 * underlying local/remote connection. Calls already in flight finish on the
 * provider they started with; retired providers close after their last call.
 */
export class KnowledgeProviderRouter {
  readonly provider: KnowledgeProvider
  private current: ProviderState
  private readonly states = new Set<ProviderState>()
  private closing = false

  constructor(initial: KnowledgeProvider, options: { owned?: boolean } = {}) {
    this.current = this.state(initial, options.owned !== false)
    this.provider = new Proxy({} as KnowledgeProvider, {
      get: (_target, property) => {
        if (property === 'mode') return this.current.provider.mode
        if (property === 'close') return () => this.close()
        const state = this.current
        const member = Reflect.get(state.provider, property) as unknown
        if (typeof member !== 'function') return member
        return (...args: unknown[]) => this.invoke(state, property, args)
      },
    })
  }

  async replace(next: KnowledgeProvider, options: { owned?: boolean } = {}): Promise<void> {
    if (this.closing) {
      await next.close()
      throw new Error('knowledge provider router is closing')
    }
    const previous = this.current
    this.current = this.state(next, options.owned !== false)
    previous.retired = true
    // Closing a retired provider is cleanup; it must not make an already
    // completed switch look like it failed to callers.
    await this.closeWhenIdle(previous).catch(() => {})
  }

  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    for (const state of this.states) state.retired = true
    await Promise.all([...this.states].map(state => this.closeWhenIdle(state)))
  }

  private state(provider: KnowledgeProvider, owned: boolean): ProviderState {
    const state: ProviderState = { provider, owned, active: 0, retired: false }
    this.states.add(state)
    return state
  }

  private async invoke(state: ProviderState, property: string | symbol, args: unknown[]): Promise<unknown> {
    if (this.closing) throw new Error('knowledge provider is closed')
    state.active += 1
    try {
      const method = Reflect.get(state.provider, property) as (...values: unknown[]) => unknown
      return await Reflect.apply(method, state.provider, args)
    } finally {
      state.active -= 1
      if (state.active === 0) state.resolveIdle?.()
      if (state.retired) void this.closeWhenIdle(state)
    }
  }

  private closeWhenIdle(state: ProviderState): Promise<void> {
    if (!state.retired) return Promise.resolve()
    if (state.active > 0) {
      if (state.idlePromise === undefined) {
        state.idlePromise = new Promise(resolve => { state.resolveIdle = resolve })
      }
      return state.idlePromise.then(() => this.closeWhenIdle(state))
    }
    if (!state.owned) {
      this.states.delete(state)
      return Promise.resolve()
    }
    if (state.closePromise === undefined) {
      state.closePromise = state.provider.close().finally(() => { this.states.delete(state) })
    }
    return state.closePromise
  }
}
