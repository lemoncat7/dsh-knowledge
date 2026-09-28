import assert from 'node:assert/strict'
import test from 'node:test'
import { observeWritebackVisibility } from '../lib/writeback/status-visibility.js'

test('historical tails do not request or subscribe until visible; resume and cleanup remain reliable', () => {
  let callback, disconnected = false, subscribed = 0, closed = 0
  const win = new EventTarget()
  win.IntersectionObserver = class {
    constructor(fn) { callback = fn }
    observe() {}
    disconnect() { disconnected = true }
  }
  const doc = Object.assign(new EventTarget(), {defaultView:win, hidden:false})
  const visibility = []
  const stop = observeWritebackVisibility({ownerDocument:doc}, {setVisible:value=>visibility.push(value)}, () => {subscribed++; return ()=>closed++})
  assert.deepEqual(visibility,[false])
  assert.equal(subscribed,0)
  callback([{isIntersecting:true}])
  win.dispatchEvent(new Event('focus'))
  assert.equal(subscribed,1)
  doc.hidden=true; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(closed,1)
  doc.hidden=false; doc.dispatchEvent(new Event('visibilitychange'))
  assert.equal(subscribed,2)
  callback([{isIntersecting:false}])
  assert.equal(closed,2)
  stop()
  const count=visibility.length
  win.dispatchEvent(new Event('focus'))
  assert.equal(visibility.length,count)
  assert.equal(disconnected,true)
})

test('browsers without IntersectionObserver still load status and respect document visibility', () => {
  const win=new EventTarget(), doc=Object.assign(new EventTarget(),{defaultView:win,hidden:false})
  const seen=[]
  const stop=observeWritebackVisibility({ownerDocument:doc},{setVisible:v=>seen.push(v)},()=>()=>{})
  assert.deepEqual(seen,[true])
  stop()
  assert.deepEqual(seen,[true,false])
})
