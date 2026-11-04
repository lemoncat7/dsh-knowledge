import { join, resolve } from 'node:path'
import { NoteReplica, type NoteTransport } from './replica.js'
import { NoteVault } from './vault.js'
import { syncError } from './sync-protocol.js'
interface Shared {
  replica: NoteReplica
  vault: NoteVault
  users: number
  closing: boolean
  transport: NoteTransport
}
const shared = new Map<string, Shared>()
/** Connection settings can change while the previous provider is retiring. Share its queue. */
export function acquireRemoteWorkspace(root: string, transport: NoteTransport) {
  const key = resolve(root)
  let state = shared.get(key)
  if (state?.closing) throw syncError(423, '笔记工作区正在关闭，请稍后重新连接')
  if (!state) {
    const holder = { transport }
    const replica = new NoteReplica(join(key, 'sync.sqlite'), (...args) => holder.transport(...args), false)
    const vault = new NoteVault(
      join(key, 'vault'),
      {
        all: () => replica.all(),
        read: (id) => replica.read(id),
        update: (id, b, v) => replica.change(id, { content: b }, v),
        create: (k, n, p, b) => replica.create(k, n, p, b),
      },
      join(key, 'vault-index.json'),
    )
    state = Object.assign(holder, { replica, vault, users: 0, closing: false })
    shared.set(key, state)
    // Start the periodic worker only after both adapters are ready.
    replica.start()
  }
  state.transport = transport
  state.users++
  const value = state
  let released = false
  return {
    replica: state.replica,
    vault: state.vault,
    async release() {
      if (released) return
      released = true
      if (--value.users === 0) {
        value.closing = true
        await value.vault.close()
        await value.replica.close()
        if (shared.get(key) === value) shared.delete(key)
      }
    },
  }
}
