import { randomBytes } from 'node:crypto'

/** Bounded, ephemeral references. Never substitute a reference from another session. */
export class SessionReferences {
  private readonly items = new Map<string, { session: string; signed: string; expires: number }>()
  private readonly reverse = new Map<string, string>()
  constructor(private readonly max = 4096, private readonly ttl = 24 * 60 * 60 * 1000,
    private readonly now = Date.now) {}

  clear(): void { this.items.clear(); this.reverse.clear() }

  put(session: string, signed: string): string {
    const key = this.reverse.get(signed)
    if (key) {
      const existing = this.items.get(key)
      if (existing && existing.expires > this.now()) {
        existing.expires = this.now() + this.ttl
        this.items.delete(key); this.items.set(key, existing)
        return key
      }
      this.remove(key)
    }
    while (this.items.size >= this.max) this.remove(this.items.keys().next().value!)
    const ref = `k1.${randomBytes(16).toString('base64url')}`
    this.items.set(ref, { session, signed, expires: this.now() + this.ttl })
    this.reverse.set(signed, ref)
    return ref
  }

  get(ref: string, session: string): string {
    const item = this.items.get(ref)
    if (!item || item.expires <= this.now()) {
      if (item) this.remove(ref)
      throw new Error('[REFERENCE_UNAVAILABLE] invalid knowledge handle: 短引用不存在或已失效（可能重启、切换来源或缓存过期）；请重新 knowledge_search 并 knowledge_read，不要重复提交或自行拼接旧引用。')
    }
    if (item.session !== session) throw new Error('[REFERENCE_SESSION_MISMATCH] knowledge handle does not belong to this session；请在当前会话重新搜索。')
    this.items.delete(ref); this.items.set(ref, item)
    item.expires = this.now() + this.ttl
    return item.signed
  }

  private remove(ref: string): void {
    const item = this.items.get(ref)
    if (item) this.reverse.delete(item.signed)
    this.items.delete(ref)
  }
}
