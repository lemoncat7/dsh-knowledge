const queues = new Map<string, Promise<void>>()

/**
 * Serialize Markdown projection work for one managed document root.
 *
 * A local DSH process may hold separate provider instances for the active
 * agent connection and the management API. They share SQLite and the same
 * document directory, so filesystem reconciliation must be ordered across
 * instances rather than only within one provider object.
 */
export function enqueueDocumentProjection<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(root) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  const tail = result.then(() => {}, () => {})
  queues.set(root, tail)
  void tail.finally(() => {
    if (queues.get(root) === tail) queues.delete(root)
  })
  return result
}
