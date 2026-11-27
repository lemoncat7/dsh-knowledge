import { createWikiDirectoryBrowser } from "./wiki-directory-browser.js"

/**
 * 结构同步提醒：区段标记按旧 section() 辅助函数的形状内联在两处——
 * 本文件下文的 `section`（知识库区）与 wiki-workspace-scan.js 的 `dailySection`（扫描更新区）。
 * 两者都是 section.wiki-section + h2 +（说明 p）+ 内容，改这一层结构或说明文字时两处必须同步，
 * 否则两个区段的外观会漂移。t31 复核 F2：此处刻意保留内联，不再恢复公共辅助函数。
 */

const unreadable = item => ['invalid', 'too_long'].includes(item.status)
// Mirrors src/wiki/diagnostics.ts for reports stored before the host kept a readable reason.
const REJECTION_REASONS = {
  INVALID_MARKDOWN: 'front matter 解析失败，读不出标题与来源',
  UNKNOWN_SCOPE: 'scope 字段不是受支持的 global / project 结构',
  UNKNOWN_PROVENANCE: 'provenance 字段不在允许取值内',
  INVALID_ARGUMENT: 'front matter 取值不合法（status 只能是 active / archived）',
  WIKI_PAGE_BODY_EMPTY: '页面正文为空',
  WIKI_PAGE_BODY_TOO_LONG: '正文超过 50000 字符',
  PATH_ESCAPE: '页面路径指向 Wiki 文件夹之外（可能是符号链接）',
  RESERVED_PATH: '页面路径命中保留名或非法字符',
}
const REJECTION_SUFFIX = '，因此未登记、不可检索；原文件未被改写'

/**
 * Connection state and the directory/onboarding settings.
 *
 * Renders the knowledge-base section plus the connect form, and explains rejected old pages.
 * It toggles the scan panels through `context.panels`, which the workspace fills during assembly.
 */
export function createConnectionBlock(context) {
  const { element, actionButton, badge, interfaceIcon, openModal, bases, state, url, call, run } = context
  const connectionView = element('div', { class: 'wiki-connection', role: 'status' })
  const baseSelect = element('select', { class: 'select', 'aria-label': '选择知识库' }, bases.map(b => element('option', { value: b.id }, b.name)))
  const sourceInput = element('input', { class: 'input', placeholder: '源文件夹（新原件放在这里）', 'aria-label': '源文件夹' })
  const workspaceInput = element('input', { class: 'input', placeholder: 'Wiki 成文文件夹（直接选择 wiki）', 'aria-label': 'Wiki 文件夹' })
  const rawInput = element('input', { class: 'input', placeholder: '留空则使用工作区/raw', 'aria-label': 'raw 目录' })
  const conversationToggle = element('input', { type: 'checkbox' })

  function browse(input, label) {
    return createWikiDirectoryBrowser({ api: call, endpoint: url("browse"), element, actionButton, interfaceIcon, openModal,
      initial: input.value.trim(), label,
      onSelect: path => { input.value = path; input.dispatchEvent(new Event("input", { bubbles: true })); context.status.textContent = "已选择 " + path },
    })
  }

  const pathField = (input, label) => element('div', { class: 'wiki-path-field' },
    input,
    actionButton('选择目录', () => browse(input, label), 'ghost small', { 'aria-label': `选择${label}` }))

  async function refreshConfig() {
    state.configs = await call('wiki')
    const current = state.configs.find(entry => entry.kbId === context.kbId)
    sourceInput.value = current?.layout.sourceDir ?? ''
    workspaceInput.value = current?.layout.pageDir ?? ''
    rawInput.value = current?.layout.rawDir ?? ''
    conversationToggle.checked = Boolean(current?.conversationEnabled)
    return current
  }

  /**
   * Stored reports keep the failing class in three shapes: `CODE：…`, `CODE: …` and a stringified
   * `Error: CODE`. All three resolve to one code so a bare class still gets a readable reason.
   */
  function rejectionCode(item) {
    if (item.errorCode) return item.errorCode
    const match = /^(?:Error:\s*)?([A-Z][A-Z0-9_]{2,})(?=[：:]|\s*$)/.exec(String(item.error ?? '').trim())
    return match?.[1] ?? 'WIKI_PAGE_UNREADABLE'
  }
  /** The code is shown on its own, so the stored prefix is dropped before the reason is displayed. */
  function pageReason(item, code) {
    if (item.errorReason) return item.errorReason
    const detail = String(item.error ?? '')
      .replace(/^Error:\s*/, '')
      .replace(new RegExp('^' + code + '\\s*[:：]?\\s*'), '')
      .trim()
    const base = REJECTION_REASONS[code]
    if (!base) return detail || '页面无法读取或解析'
    if (!detail) return base + REJECTION_SUFFIX
    return (/\p{Script=Han}/u.test(detail) ? detail : `${base}（${detail}）`) + REJECTION_SUFFIX
  }
  /**
   * Old stored reports only carried a prose error per page, so recover the code from the message
   * prefix and group them the same way the current report does.
   */
  function issueGroups(report) {
    const rejected = (report.items ?? []).filter(unreadable)
    if (report.issues?.length) return { rejected, issues: report.issues }
    const groups = new Map()
    for (const item of rejected) {
      const code = rejectionCode(item)
      const group = groups.get(code) ?? { code, reason: pageReason(item, code), count: 0, examples: [] }
      group.count += 1
      if (group.examples.length < 3) group.examples.push(item.relPath)
      groups.set(code, group)
    }
    return { rejected, issues: [...groups.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)) }
  }

  /** A count alone explains nothing: state the meaning, group the reasons, show real paths and the way out. */
  function renderRejections(report) {
    const { rejected, issues } = issueGroups(report)
    if (!report.rejected || !rejected.length) return
    const block = element('div', { class: 'wiki-explain', role: 'group', 'aria-label': '异常页面说明' })
    block.append(element('p', { class: 'wiki-explain-title' }, `异常 ${report.rejected} 篇是什么意思`))
    block.append(element('p', { class: 'wiki-hint' },
      '这些页面没有登记进 Wiki 索引，所以也搜不到。最常见的原因是正文开头的 front matter（--- 之间的元数据）无法解析，'
      + '读不出标题与来源；正文超过 5 万字符同样会被拒绝。页面文件本身没有被修改，仍原样留在 wiki 文件夹里。'))
    const list = element('ul', { class: 'wiki-issues' })
    for (const issue of issues) {
      const row = element('li', { class: 'wiki-issue' },
        element('span', { class: 'wiki-issue-count' }, `${issue.count} 篇`),
        element('span', { class: 'wiki-issue-code' }, issue.code),
        element('span', { class: 'wiki-issue-reason' }, issue.reason))
      if (issue.examples?.length) row.append(element('small', { class: 'wiki-issue-examples' }, '示例：' + issue.examples.join('、')))
      list.append(row)
    }
    block.append(list)
    block.append(element('p', { class: 'wiki-hint' },
      '怎么处理：把这些页面 front matter 里含冒号或反斜杠的取值加上引号，修好后点「刷新状态」或重新接入一次即可登记；'
      + '在修好之前，其余页面照常可搜可用。'))
    const details = element('details', { class: 'wiki-details wiki-rejection-list' },
      element('summary', {}, `查看异常清单（${rejected.length} 条）`))
    for (const item of rejected.slice(0, 200)) {
      details.append(element('div', { class: 'wiki-row wiki-row-detail' },
        element('span', { class: 'wiki-path', title: item.relPath }, item.relPath),
        item.metadataRepair ? badge('需修复元数据', 'warning') : null,
        element('small', { class: 'wiki-error' }, pageReason(item, rejectionCode(item)))))
    }
    if (rejected.length > 200) details.append(element('p', { class: 'wiki-hint' }, `还有 ${rejected.length - 200} 条未列出。`))
    block.append(details)
    connectionView.append(block)
  }

  function renderConnection(value) {
    const labels = { unconfigured: '未接入', configured: '目录已保存，尚未接入', ready: '已接入', partial: '部分接入', failed: '接入失败' }
    const connected = ['ready', 'partial'].includes(value.state)
    if (context.panels.settings) context.panels.settings.open = !connected
    if (context.panels.daily) context.panels.daily.hidden = !connected
    if (context.panels.changes) context.panels.changes.hidden = !connected
    connectionView.replaceChildren(element('strong', {}, labels[value.state] || '正在检查接入状态'))
    if (value.layout) connectionView.append(element('p', { class: 'wiki-hint' }, '成文目录：' + value.layout.pageDir))
    if (value.report) {
      const report = value.report
      const summary = ['本次登记 ' + report.registered + ' 篇', '已登记 ' + report.existing + ' 篇']
      // Repaired pages are readable through the restricted rule, but the manifest still flags them.
      if (report.repaired) summary.push('需修复元数据 ' + report.repaired + ' 篇')
      if (report.rejected) summary.push('异常 ' + report.rejected + ' 篇（未登记、不可检索）')
      connectionView.append(element('p', { class: 'wiki-hint' }, summary.join(' · ')))
      if (report.repaired) connectionView.append(element('p', { class: 'wiki-hint' },
        report.repaired + ' 篇旧页已按受限规则读取，并在清单里标记「需修复元数据」；文件未改动。'))
      if (!(report.items ?? []).length) connectionView.append(element('p', { class: 'wiki-hint' }, '还没有页面，可添加原件后扫描更新。'))
      renderRejections(report)
    }
    if (value.error) connectionView.append(element('p', { class: 'wiki-error' }, value.error))
  }

  const section = element('section', { class: 'wiki-section' },
    element('h2', {}, '知识库'),
    element('div', { class: 'wiki-toolbar' }, baseSelect),
    connectionView)

  const settings = element('details', { class: 'wiki-details wiki-connect-settings' },
    element('summary', {}, '目录与接入设置'),
    element('h2', {}, '接入知识库'),
    element('p', { class: 'wiki-hint' }, '首次接入只登记和索引已有页面，不改原文、不移动原件、不调用模型。'),
    element('div', { class: 'wiki-grid' }, pathField(sourceInput, '源文件夹'), pathField(workspaceInput, 'Wiki 文件夹'), pathField(rawInput, 'raw 文件夹')),
    element('p', { class: 'wiki-hint' }, '直接选择存放成文的 wiki 文件夹；不会再追加一层 wiki。新库按普通知识库使用，已有页面范围保持不变。'),
    element('details', { class: 'wiki-details' }, element('summary', {}, '更多设置'),
      element('label', { class: 'check-option' }, conversationToggle, element('span', {}, '允许对话证据写入该库'))),
    element('div', { class: 'wiki-actions' },
      actionButton('接入知识库', () => void run(async () => {
        try {
          const result = await call(url('connect'), { method: 'POST', body: {
            sourceDir: sourceInput.value.trim(), wikiDir: workspaceInput.value.trim(),
            ...(rawInput.value.trim() ? { rawDir: rawInput.value.trim() } : {}),
            conversationEnabled: conversationToggle.checked,
          } })
          renderConnection(result); await context.reload()
          return result.state === 'partial' ? '部分接入，请查看异常文件' : '接入完成，可投递原件后扫描更新'
        } catch (error) {
          renderConnection(await call(url('connection')))
          throw error
        }
      }), 'small'),
      actionButton('刷新状态', () => void run(context.reload), 'ghost small')))

  return { section, settings, baseSelect, connectionView, workspaceInput, renderConnection, refreshConfig }
}
