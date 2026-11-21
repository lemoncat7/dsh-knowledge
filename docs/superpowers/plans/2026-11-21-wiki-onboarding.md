# Wiki 首次接入与日常更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. 用户已要求本会话直接实施，不派子代理。

**Goal:** 让用户一次完成目录接入，以后只需扫描更新并看 AI 处理结果。

**Architecture:** 服务端增加明确的接入状态与编排入口，复用文件权威清单、提交器和索引桥；前端根据服务端接入状态显示首次设置或日常工作台。目录配置不再代表接入成功，模型流水线不在首次接入执行。

**Tech Stack:** TypeScript ESM、Node SQLite、原生 Web DOM、node:test；不增加依赖。

**Spec:** `docs/superpowers/specs/2026-11-21-wiki-onboarding-design.md`

## Global Constraints

- 不移动原件、不重写既有 Markdown、不调用模型、不排旧素材任务（首次接入）。
- 项目范围必须明确；不得默认将未知权限扩成全局。
- 重复接入不新增身份、不重蒸、不改旧页面权限。
- 默认保留现有旧页更新人工审核保护，不擅自启用自动替换。
- 沿用现有主题令牌，不换视觉体系；无新依赖。
- 工作区下 `wiki/` 是成文目录；只显示解析结果，不悄悄纠正用户路径。

## Review Focus

- 接入遇到损坏清单/未恢复提交：明确失败，不能覆盖权限或误报 ready（任务1、2）。
- 报告生成后文件被外部改动：提交重验哈希，不接纳过时快照（任务1）。
- 空库/混合有效无效页/重复请求：结果准确且身份幂等（任务1、2）。
- 入库轮询或接入响应在切库/离开后返回：不污染新库或继续后台轮询（任务3、4）。
- 原件仅登记或旧页候选待审：不能误报“新增知识页成功”（任务4）。

---

### Task 1: 安全的逐项登记与结果报告

**Files:** 修改 `src/wiki/store.ts`；新增 `test/wiki-onboarding.test.mjs`。

**Interfaces:** 新增 `WikiImportReport = {items: WikiImportItem[]; registered:number; existing:number; rejected:number}`；新增 `WikiStore.importValid(scope:KnowledgeScope, operationId:string):Promise<WikiImportReport>`，原 `import` 严格行为保留。

- [ ] 写失败测试：有效页+格式坏页，仅有效页登记，报告各项；原件/正文哈希不变；重复登记 pageId 不变；检查到提交之间页面变动应冲突；损坏清单拒绝。
- [ ] 编译并运行新测试，确认因接口缺失失败。
- [ ] 实现：读取一次待接纳字节与哈希，发布前重验；有效条目批量提交身份清单，失败页不进索引；禁止重新解释已登记范围。
- [ ] 跑新测试与 `test/wiki-gate-a.test.mjs test/wiki-review-regressions.test.mjs`，全部通过。
- [ ] 提交 `feat(wiki): report safe partial registration of existing pages`。

### Task 2: 接入编排与服务端状态

**Files:** 修改 `src/wiki/provider-bridge.ts`、`src/wiki/api.ts`；扩展 `test/wiki-onboarding.test.mjs`。

**Interfaces:** `WikiProviderBridge.connect(input: configure参数 & {scope:KnowledgeScope}):Promise<WikiConnectionReport>`；`connectionStatus(kbId:string)` 返回 `unconfigured|configured|ready|partial|failed` 和持久报告。`WikiConnectionReport` 含状态、实际布局、任务1报告和错误原因；`POST wiki/:kbId/connect` 调用，`GET wiki/:kbId/connection` 查询。

- [ ] 写失败测试：保存配置但未接入为 configured；connect 空库ready、部分页partial、索引失败failed、成功后可检索；重复connect无新ID；无模型/原件改动；已配置旧版本无状态记录不误判ready。
- [ ] 实现单库串行编排：验证/配置→恢复检查→importValid→重建→持久状态；异常落failed。新增独立SQLite表，兼容已有数据库；绝不删除现有任务/候选。
- [ ] 管理端路由沿用 same-origin admin 门，校验 scope，保留旧接口兼容。
- [ ] 新旧后端用例通过并提交 `feat(wiki): connect directories and existing pages in one operation`。

### Task 3: 两态工作台与统一接入按钮

**Files:** 修改 `web/wiki-workspace.js`、`web/styles.css`、`test/wiki-workspace-ui.test.mjs`。

**Interfaces:** 前端只依任务2 connection状态切换。输入范围随connect发送；已有配置显示实际pageDir。统一「接入知识库」「扫描更新」文案；高级内保留维护按钮。

- [ ] 写失败测试：未接入显示目录与接入；configured不误报成功；ready显示状态与折叠设置；partial展示逐文件原因；空库提示可投递；无独立存量接管栏；更新审核仍存在。
- [ ] 实现最小两态布局和连接结果区域，不用英文内部状态当主提示；把旧维护动作移高级。
- [ ] 绑定工作台生命周期/固定kbId与请求generation：切库取消旧任务读请求；页面卸载停止定时器；忙时保持原库。
- [ ] 慢响应/离开回归通过，提交 `feat(wiki-ui): separate first connection from daily updates`。

### Task 4: 扫描更新与真实结果

**Files:** 修改 `src/wiki/ingest.ts`、`src/wiki/api.ts`、`web/wiki-workspace.js`；测试 `test/wiki-ingest.test.mjs test/wiki-workspace-ui.test.mjs`。

**Interfaces:** 更新入口 `POST wiki/:kbId/update` 接受现有入库设置及scope，先任务2的文件登记/索引对账再start，返回 `{connection:WikiConnectionReport, job:WikiIngestJob, reused:boolean}`。运行任务复用时reused=true，不伪报新发现；页面回执沿用job.items[].pages，标签区分“关联页”与可证明的新增/更新。

- [ ] 写失败测试：新旧成文+新原件两类结果；重复点击运行中返回reused；登记型文件无页不当知识页；待审核只报候选；0个待处理清楚提示根目录规则。
- [ ] 实现后端编排和UI两段结果；任务完成展示可打开关联成文页、错误与待审，不要求用户编辑。
- [ ] 定时器自动刷新、结束停、失败显式提示；网络重试有上限/退避，不伪装正常运行。
- [ ] 对新测试观察红→绿，提交 `feat(wiki): report daily update outcomes and linked pages`。

### Task 5: 验证、PR与安装

**Files:** 修改 `docs/wiki-acceptance.md docs/wiki-handover.md`；本地控制日志不入PR。

- [ ] 所有树以真实 Git 分支为唯一候选，避免三个分叉。执行 `node node_modules/typescript/bin/tsc -p tsconfig.json` → `node scripts/build-client.mjs` → `node --test test/wiki-*.test.mjs test/client-bundle.test.mjs`，记录实际数量/错误。
- [ ] 运行上游完整逐文件回归；对新失败做同版本对照，不宣称全绿。检查 `git diff --check`、提交文件/隐私与依赖变更。
- [ ] 更新PR#22正文：新增行为、接口、测试、限制和实际文件统计；推送并核实远程HEAD。
- [ ] 安装前备份，只复制已验证构建；核验哈希和运行资源。宿主禁止UI自动化或缓存未更新则披露，重启只由用户执行。

## 自审

设计各项均映射任务1–5；参数命名与状态统一；原严格import兼容保留；逐项接入新接口独立。无子代理、无实际知识库测试、无擅自全自动批准。实施前用户确认本计划覆盖意图。
