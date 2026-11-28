import test from 'node:test'
import assert from 'node:assert/strict'

import { nextAckRequestId } from '../lib/calendar-ack-id.js'

/** Swap globalThis.crypto for the duration of one test, then restore it. */
async function withCrypto(value, run) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true })
  try {
    await run()
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else delete globalThis.crypto
  }
}

test('returns the platform uuid when randomUUID is available', async () => {
  await withCrypto({ randomUUID: () => 'fixed-uuid' }, () => {
    assert.equal(nextAckRequestId(), 'fixed-uuid')
  })
})

test('still returns a usable id when randomUUID throws (insecure context)', async () => {
  const hostile = { randomUUID () { throw new Error('not available in insecure contexts') } }
  await withCrypto(hostile, () => {
    const id = nextAckRequestId()
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0, 'acknowledge must still get an id, otherwise the button stays locked')
  })
})

test('still returns an id when crypto is missing entirely', async () => {
  await withCrypto(undefined, () => {
    const id = nextAckRequestId()
    assert.equal(typeof id, 'string')
    assert.ok(id.length > 0)
  })
})

test('ids stay distinct when the platform uuid is unavailable', async () => {
  const hostile = { randomUUID () { throw new Error('nope') } }
  await withCrypto(hostile, () => {
    const ids = new Set(Array.from({ length: 50 }, () => nextAckRequestId()))
    assert.equal(ids.size, 50)
  })
})
