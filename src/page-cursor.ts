/** Opaque, filter-bound keyset cursors. Never interpolate cursor data into SQL. */
export function encodePageCursor(scope: string, values: (string | number)[]): string {
  return Buffer.from(JSON.stringify({ scope, values })).toString('base64url')
}

export function decodePageCursor(cursor: string | undefined, scope: string, types: ('string' | 'number')[]): (string | number)[] | undefined {
  if (!cursor) return undefined
  try {
    if (cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error()
    const data = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (data.scope !== scope || !Array.isArray(data.values) || data.values.length !== types.length
      || data.values.some((value: unknown, index: number) => typeof value !== types[index]
        || typeof value === 'number' && !Number.isSafeInteger(value))) throw new Error()
    return data.values
  } catch { throw Object.assign(new Error('分页位置已失效，请刷新列表'), { status: 400 }) }
}
