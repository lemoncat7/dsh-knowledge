import { createHmac, timingSafeEqual } from 'node:crypto'

interface NoteHandlePayload {
  v: 1
  sessionId: string
  noteId: string
}

/** Opaque, session-bound note handles keep AI mutations on searched results. */
export class KnowledgeNoteHandleCodec {
  constructor(private readonly secret: Buffer) {
    if (secret.length < 32) throw new Error('knowledge note handle secret must contain at least 32 bytes')
  }

  encode(sessionId: string, noteId: string): string {
    const payload = Buffer.from(JSON.stringify({ v: 1, sessionId, noteId } satisfies NoteHandlePayload)).toString('base64url')
    return `n1.${payload}.${this.sign(payload)}`
  }

  decode(handle: string, sessionId: string): NoteHandlePayload {
    const parts = handle.trim().split('.')
    if (parts.length !== 3 || parts[0] !== 'n1') throw new Error('invalid knowledge note handle')
    const payload = parts[1]
    const signature = parts[2]
    if (payload === undefined || signature === undefined) throw new Error('invalid knowledge note handle')
    const expected = Buffer.from(this.sign(payload), 'base64url')
    let actual: Buffer
    try {
      actual = Buffer.from(signature, 'base64url')
    } catch {
      throw new Error('invalid knowledge note handle')
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error('invalid knowledge note handle')
    let value: unknown
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { throw new Error('invalid knowledge note handle') }
    if (!isNoteHandlePayload(value) || value.sessionId !== sessionId) {
      throw new Error('knowledge note handle does not belong to this session')
    }
    return value
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url')
  }
}

function isNoteHandlePayload(value: unknown): value is NoteHandlePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.v === 1 && typeof item.sessionId === 'string' && /^note_[a-f0-9]{32}$/u.test(String(item.noteId))
}
