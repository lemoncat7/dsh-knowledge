/**
 * Preserve input order while bounding independent asynchronous work. This is
 * primarily used for mounted remote knowledge bases, where an unbounded
 * Promise.all would otherwise turn one tool call into hundreds of requests.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []
  const workerCount = Math.min(items.length, Math.max(1, Math.trunc(concurrency)))
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await operation(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}
