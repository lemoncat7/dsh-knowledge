import test from 'node:test'
import assert from 'node:assert/strict'
import { planNoteContentUpdate } from '../lib/note-edit-plan.js'

test('multiple sections are located in original order and saved without altering other bytes', () => {
  const original='# 第一章\r\n旧规则甲\r\n\r\n# 保留章节\r\n原样保留\r\n# 第三章\r\n旧规则乙\r\n'
  const plan=planNoteContentUpdate(original,'batch_edit',{edits:[{oldText:'旧规则乙',newText:'新规则乙'},{oldText:'旧规则甲',newText:'新规则甲'}]})
  assert.equal(plan.content,original.replace('旧规则甲','新规则甲').replace('旧规则乙','新规则乙'))
  assert.deepEqual(plan.preview.locations.map(x=>[x.section,x.startLine,x.endLine]),[['第一章',2,2],['第三章',7,7]])
  assert.equal(plan.preview.changeCount,2)
  for(const text of ['旧规则甲','新规则甲','旧规则乙','新规则乙','修改前','修改后'])assert.ok(plan.preview.text.includes(text))
  assert.match(plan.summary,/一次确认、整体保存/)
})

test('batch rejects missing, ambiguous, overlapping and dependent anchors before any write',()=>{
  const cases=[
    [{oldText:'missing',newText:'new'}],
    [{oldText:'a',newText:'new'}],
    [{oldText:'abc',newText:'new'},{oldText:'bc',newText:'other'}],
    [{oldText:'abc',newText:'new'},{oldText:'new',newText:'dependent'}],
    [{oldText:' ',newText:'new'}],
  ]
  for(const edits of cases)assert.throws(()=>planNoteContentUpdate('abc abc2','batch_edit',{edits}))
  assert.throws(()=>planNoteContentUpdate('abcdef','batch_edit',{edits:[{oldText:'abc',newText:'x'},{oldText:'bcde',newText:'y'}]}),/重叠/)
  assert.throws(()=>planNoteContentUpdate('abc','batch_edit',{edits:[{oldText:'abc',newText:'x'}],value:'ignored'}),/不要同时/)
  assert.throws(()=>planNoteContentUpdate('abc','batch_edit',{edits:[]}),/1–100/)
})

test('full rewrite preview contains the exact changed window, with unchanged edge lines omitted',()=>{
  for(const [original,value] of [['# A\nold\n# End\nkeep','# A\nnew\n# End\nkeep'],['a\nb','a\nb\nnew'],['a\nb\nc','a\nc'],['','first'],['a\n','a\nb']]){
    const plan=planNoteContentUpdate(original,'replace_content',{value})
    assert.equal(plan.content,value)
    assert.match(plan.preview.text,/修改前：[\s\S]+修改后：/)
    assert.match(plan.summary,/整篇覆盖/)
  }
  const plan=planNoteContentUpdate('# A\nold\n# End\nkeep','replace_content',{value:'# A\nnew\n# End\nkeep'})
  assert.ok(!plan.preview.text.includes('keep'))
  assert.equal(plan.preview.locations[0].section,'A')
})

test('deletion, fenced content and no-op safety',()=>{
  const original='# 实际章节\n```md\n# 代码不是章节\n```\nremove\nkeep'
  const plan=planNoteContentUpdate(original,'batch_edit',{edits:[{oldText:'remove\n',newText:''}]})
  assert.equal(plan.preview.locations[0].section,'实际章节')
  assert.match(plan.preview.text,/修改后：\n（空）/)
  const fenced=planNoteContentUpdate('old','replace_range',{oldText:'old',value:'```code```'})
  assert.ok(fenced.preview.text.includes('````text'))
  assert.throws(()=>planNoteContentUpdate('a','batch_edit',{edits:[{oldText:'a',newText:' a '}]}),/空白变化/)
})
