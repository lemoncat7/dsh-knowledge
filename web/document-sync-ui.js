/** Conflict resolution is explicit: the remote version becomes the new base,
 * and the user's chosen text remains a draft until saved with a version check. */
export function openSyncConflict({ element, actionButton, openModal, openConfirm, renderDiff, local, remote, apply, useRemote, canEdit = true, allowTitle = true }) {
  const title = element('input', { class: 'input', value: local.title, 'aria-label': '合并后的标题', disabled: !canEdit || !allowTitle })
  const content = element('textarea', { class: 'input sync-merge-content', 'aria-label': '合并后的正文', spellcheck: 'false', disabled: !canEdit }, local.content)
  const remoteText = element('textarea', { class: 'input sync-merge-content', readonly: true, 'aria-label': '服务端最新正文', spellcheck: 'false' }, remote.content)
  let modal
  const body = element('div', { class: 'sync-conflict-body' },
    element('p', {}, '你的未保存内容仍保留。请对照最新版本整理，应用后回到文档点击保存；保存时会再次检查版本。'),
    element('details', {}, element('summary', {}, '查看最新版本与本地草稿的差异'), renderDiff(remote.content, local.content, '最新版本 → 本地草稿')),
    element('div', { class: 'sync-merge-columns' },
      element('section', {}, element('h3', {}, '服务端最新版本'), element('p', {}, remote.title), remoteText),
      element('section', {}, element('h3', {}, '整理合并后的草稿'), title, content)),
    !canEdit ? element('p', { role: 'status' }, '此知识文档已封存或归档，不能直接保存。你的草稿仍可在原编辑器中保留。') : null,
    actionButton('放弃本地修改，使用最新版本', () => openConfirm({
      title: '使用最新版本？', message: '将放弃这份未保存的本地草稿。', confirmLabel: '放弃草稿并加载', danger: true,
      onConfirm: async () => { await useRemote(); modal.close(true) },
    }), 'small'),
  )
  modal = openModal({ title: '文档有新版本', description: '不会自动覆盖任何一方的修改', body, className: 'sync-conflict-dialog', cancelLabel: '继续保留草稿',
    ...(canEdit ? { primaryLabel: '应用到草稿', onPrimary: async () => { await apply({ title: title.value, content: content.value }); return true } } : {}),
  })
}
