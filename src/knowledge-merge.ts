/**
 * Merge document bodies without discarding either side.
 *
 * The server transaction and management-console preview share this function,
 * keeping the displayed change set aligned with the content that is written.
 */
export function mergeKnowledgeBodies(current: string, incoming: string): string {
  const currentKey = normalizedBody(current)
  const incomingKey = normalizedBody(incoming)
  if (currentKey === incomingKey || currentKey.includes(incomingKey)) return current.trim()
  if (incomingKey.includes(currentKey)) return incoming.trim()
  return `${current.trim()}\n\n${incoming.trim()}`
}

function normalizedBody(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/gu, ' ').trim()
}
