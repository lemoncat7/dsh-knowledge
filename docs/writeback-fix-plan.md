# dsh-knowledge 回写可靠性修复 + 导入/导出 — Coding Plan（已批准）

状态：**已批准，实施中**（2026-08-31 用户逐条 review 定稿并放行）。
实现仓库：`D:\Ollama\projects\github\dsh-knowledge`（工作区源码 2.1.1；实际安装于 `~/.dsh/profiles/web` 的是 1.1.5 独立副本，信号链已核实一致）。
同步副本：Mnemon 项目文档《dsh-knowledge 回写可靠性修复与导入导出 — 设计与实施 Plan》。

## 1. 根因（已代码 + DB 取证）

1. `extractionTimeoutMs` 默认 90s（src/config.ts:44）；长答案提取模型调用必超时。pi-ai 在 signal abort 时统一抛 `Request was aborted` 并丢弃 `signal.reason` → 超时/回合中断在 `extraction_jobs.last_error` 中不可分辨（DB 中 3 条 failed 全为此值、attempts=1）。
2. 无自动重试：`claimExtraction` 的 `attempts<3` 只是领取上限（local-provider.ts:1383），不存在任何调度器。
3. 手动重试（POST /knowledge-control/v1/writeback-status）用 fresh signal + resetExtraction，但同样预算跑同样长内容 → 确定性复败。
4. 回合中断：dsh-agent-loop `cancel()` → `phase.abort.abort()`（lib/index.js:410,565）→ 插件 parentSignal；`runWriteback` 的 `if (signal.aborted) throw error`（index.ts:352）在落终态前抛出 → `writebackStatuses` 永久 running、UI 无重试按钮、该轮永无再次回写。

## 2. 已确认决策

- **detached 为默认**：新增 `extractionMode: 'detached' | 'inline'`，默认 detached；inline 保留旧行为。
- **extractionTimeoutMs 默认 300_000**；保留配置 `0` = 禁用单次超时的语义（逃生门，非默认）。
- **自动重试链**：首次失败 → 退避 20s → 重试1（预算 300s）→ 失败 → 退避 60s → 重试2（预算 300s）→ 失败 → 退避 60s → **最后一搏（超时 30 分钟，常量 `FINAL_ATTEMPT_TIMEOUT_MS`）** → 仍失败 → `failed+retryable`。兜底前 `resetExtraction`（绕过 DB attempts<3）；调度器用内存 `autoRetryCount` 计数。
- **重试按钮仅在整条链全部失败后出现**；链运行中保持 `running` + 阶段文案（"20 秒后自动重试（1/2）"等）。手动重试 = reset + 重开整条链，不是无限自动循环。
- **最后一搏失败后自动导出待抽取内容为 MD，落点 B：`<DSH home>/knowledge/exports/`**。
- **「导入文件」按钮只支持 `.md/.markdown`**（不做 html/pdf/word 转换、不做转换 bundle、不做从笔记导入）。

## 3. W1 修复（src/index.ts、src/extraction.ts、src/config.ts、src/local-provider.ts）

- extraction.ts `callExtractionModel`：catch 中区分 abort 来源——`controller.signal.aborted && !parentSignal.aborted` → 抛 `知识提取超时（预算 Nms）`；parentSignal.aborted → 抛 `回合已中断`；最后一搏用 `options.timeoutMs` 覆盖（`run()` 增加 `options?: { timeoutMs?: number }` 逐层穿透 `extractWithLlm → callStructuredModel → callExtractionModel`）。
- index.ts `runWriteback`：任何失败（含 signal.aborted）都先落 `failed+retryable` 终态再决定上抛；初跑 summary "正在重试" 改 "正在回写"。
- index.ts：自动重试调度器（pending-timer Map 防重；退避 20s/60s；autoRetryCount 计数；重跑前查 `provider.extractionJob(key)`；dispose 清空全部 timer）。
- local-provider.ts `claimExtraction` 增加可选 `leaseMs`（默认 15min 不变）；最后一搏 claim 时传 35min，消除 30min 尝试期间 "running 且超 15min" 的 stale 竞态（remote provider 忽略该参数，残余风险仅限同库双实例，可接受）。

## 4. W2 后台化（detached）

- extraction.ts `run()`：工作信号 = `AbortSignal.any([timeoutController, shutdown])`，不再合并 parentSignal。
- index.ts：detached 模式下 turn-stopping handler 为 `void runWriteback(...)`（内部 catch 记日志+落终态），不 await → 不阻塞 turn/end，追问不再中断回写。
- coordinator 维护 in-flight 集合；`close()` 先 `shutdown.abort` 再 `await Promise.allSettled(inflight)`（宽限 30s）。
- 幂等不变：sourceKey 唯一 claim + 租约；UI 零改动（turnTail 轮询 GET writeback-status）。
- 边界：进程被直接杀 → 任务丢、job 停 running、租约过期后可重新领取；跨重启自动重试不做（需持久化 turn 快照，收益低）。

## 5. W3 失败导出（落点 B 已确认）

- **默认目录：`<DSH home>/knowledge/exports/`**（本机即 `C:\Users\reame\.dsh\knowledge\exports\`，与 knowledge.sqlite/notes/documents 同级）。
- 实现要点：cordis.patch.yml 增加配置项 `exportsDir: !!js dshHomePath('knowledge/exports')` 作为默认值——**不用 `dirname(databasePath)` 推导**，因为 remote 后端没有本地 databasePath；导出是本机救援产物，永远写客户端自己的 DSH home，**绝不通过 provider 写库**（local 不污染库目录结构，remote 不写中央服务端）。config 可显式覆盖 exportsDir；resolveConfig 缺省回退：exportsDir 未配置且 backend=local 时用 `dirname(databasePath)/exports`，remote 且未配置则跳过导出并在状态里注明。
- 触发：自动链（含 30min 最后一搏）全部失败后、落 failed 终态前执行一次（source.agent 快照仍在内存，可重建 turn 内容）。
- 内容：H1 = 用户提问首行截断 ≤60 字；blockquote `> 来源：DSH 会话 <id 前 8> 第 <turn> 轮（<date>）· dsh-knowledge 导出`；`## 用户提问` 全文；`## 助手回答` 全文；顶部 HTML 注释 provenance（不用 YAML front matter，避免与 parseKnowledgeMarkdown 校验冲突）。
- UI：失败状态显示「已导出：回写失败-xxx.md」+「下载 Markdown」按钮——客户端 fetch 控制端点（带 `x-dsh-knowledge-client: conversation-web` 头）取 blob 后 `a.download` 触发保存到浏览器下载目录（裸 `<a href>` 不携带自定义头会 401，必须 fetch+blob）。
- 控制端点：`GET /knowledge-control/v1/writeback-export?sessionId&turn`，`assertKnowledgeBrowserRequest(req,'conversation-web')`，读 exportsDir 下对应文件，响应 `Content-Disposition: attachment; filename*=UTF-8''...`（RFC5987 中文文件名）。
- 文件名：`回写失败-<turn>-<MMdd-HHmmss>.md`；同 turn 同名已存在则复用；v1 不做自动清理。
- 状态：`writebackStatuses` state 增加 `export?: { fileName }`；GET /writeback-status 返回。导出失败不阻塞 failed 终态。

## 6. W4 导入文件（简化版：仅 md）

- 入口：`renderDocumentWorkspace` 工具栏「新建文档」旁加「导入文件」（库详情与会话工作区共用组件，一处改动两处生效）。
- 仅接受 `.md/.markdown`（file input accept 限定；其他格式提示不支持）；前端 `FileReader` 读文本。
- 标题：文件名去扩展名或首个 H1（`src/import-utils.ts` 纯函数，编译进 lib，浏览器与 node 测试共用）。
- >50k 处理：body 上限 50,000 字符（normalizeDraft 硬校验），超限对话框默认「按 H2 拆分为多篇（`文件名 (1/N)`）」，可选「截断」或取消。
- 创建前对话框：目标知识库（默认当前上下文）、类型（默认 fact）、标签、scope（project=当前 cwd / global）；提交复用 `POST /entries`（write），零新路由、零新依赖、零新 bundle。

## 7. 测试（test/plugin-runtime.test.mjs 扩展 + 新增）

- T1 detached：回合信号 abort（模拟追问）后提取仍完成并产出候选。
- T2 自动重试：fake llm 首次抛 abort → 退避后自动重跑成功 → attempts=2、completed、summary 注明自动重试。
- T3 中断终态化：abort 后 writebackStatuses 出现 failed+retryable（不再卡 running）。
- T4 天花板：2 次退避 + 30min 兜底全部失败后才 failed+retryable；链中保持 running。
- T5 语义化：超时 last_error 含「超时」；30min 兜底超时文案区分。
- T6 inline 回归：extractionMode='inline' 旧行为不变。
- T7 兜底超时预算：最后一搏使用 30min 预算与 35min lease（参数穿透验证）。
- T8 失败导出：兜底失败后 exportsDir 写入 md、state.export 存在、同名复用、exportsDir 未配置（remote）时状态注明跳过。
- T9 import-utils：标题推导、H2 拆分边界（50k、空节）。
- 回归命令：`npm test`（build + node --test test/*.test.mjs）。

## 8. 发布

1. 版本 bump（2.2.0）→ `npm test` → `npm pack`。
2. `dsh plugin --profile web add .\lemoncat7-dsh-knowledge-<ver>.tgz` 覆盖安装 1.1.5。
3. 重启 profile（重启会杀进行中对话；用延迟分离脚本或用户手动跑 `C:\Users\reame\.dsh\restart-dsh-web.cmd`）。
4. 实测：长回答 + 立即追问 → 回写最终落定；制造连续失败 → 观察 20s/60s/30min 链、exports/ 导出与下载按钮；导入大 md 验证拆分。

## 9. 决策记录

全部确认于 2026-08-31：detached 默认 ✅、300s 默认 ✅、重试时序（20s/60s×2 + 30min 兜底）✅、按钮仅链全败后出现 ✅、导出落点 B ✅、导入仅 md ✅。

## 10. 实施记录与偏差（2026-08-31 完成，npm test 72/72 全绿）

实现与计划完全对应（W1-W4、T1-T9、2.2.0、npm pack），以下为实施时的具体偏差与补充，均为等价或增强：

1. **重试时序全部可配置**（计划中的常量 → config）：新增 `extractionRetryDelaysMs`（默认 `[20_000, 60_000]`，最多 2 项）、`extractionFinalRetryDelayMs`（默认 60_000）、`extractionFinalTimeoutMs`（默认 1_800_000）。测试用 10ms 级时序驱动全链，用户亦可自行调节。extractionTimeoutMs schema 上限从 300_000 保持不变，0=禁用语义保留。
2. **lease = finalTimeout + 300_000**（而非固定 35min）：`extractionFinalTimeoutMs` 可配置后，lease 随之动态计算，关系不变（lease > 尝试超时 5min 余量）。
3. **import-utils 位置：`web/import-utils.js`**（而非 `src/import-utils.ts`）：app.js 是 `<script type="module">`，浏览器侧直接 `import(...?v=ASSET_VERSION)` 动态加载，零构建零依赖；node 测试直接 import 同一文件。`IMPORT_ACCEPT='.md,.markdown'`、`IMPORT_MAX_BODY_CHARS=50_000`、`titleFromMarkdown`、`splitMarkdownByH2`（H2 边界优先、无标题/超长节硬切）。
4. **POST 手动重试改为 fire-and-forget**：立即返回 `running`（"正在重试（手动）"），整条链后台执行；client.tsx 增加 5s 轮询（仅 running 期间），完成/失败后自动刷新。
5. **T7 合并进 T4**（lease 穿透由 T4 的 4 次调用断言覆盖）；T8 合并进 T4 的导出+下载+同名复用断言。
6. **detached 语义精确化**：coordinator.run 的 detached 工作信号 = `AbortSignal.any([timeoutController, shutdown])`（只排除 parentSignal）；runWriteback 收到的 parentSignal 仅用于判定"回合已中断"文案，不取消提取。detached 下 turn-stopping 对提取尚未开始的轮次照常启动（fresh AbortController），关闭时 `coordinator.close()` = shutdown.abort + allSettled(inflight) + 30s 宽限，进程退出不被卡住。
7. **测试基建坑**：node:test after 钩子按注册顺序 **FIFO** 执行（node 24 实测），旧测试"disposers+rm 钩子先注册、observer.close 后注册"会导致 rm 在 observer 未关时跑 → Windows WAL sqlite EBUSY。已统一改为钩子内先 `await observer.close()` 再 dispose 再带 EBUSY 重试的 rm；audit 测试的 `reopened` 第二连接改为测试末尾显式 close。Windows 下 POSIX mode 位断言（0o600）恒为 0o666，connection/service-settings 两测试加 `process.platform !== 'win32'` 守卫。
8. **cordis-integration 期望路由表**补上新增的 `/knowledge-control/v1/writeback-export`。
9. 发布产物：`lemoncat7-dsh-knowledge-2.2.0.tgz`（npm pack 通过，含 prepare 完整构建）。
10. **热修 2.2.1**：用户实测发现「导入组件加载失败」——`src/web.ts` 的 `STATIC_ASSETS` 是启动时读入内存的固定清单，动态 import 的 `web/import-utils.js` 未登记 → 运行时 404。已补登记并加回归断言（cordis 集成测试的 FakeWebServer 同步补齐 prefix 路由分发，实测 fetch `/knowledge/import-utils.js` 返回 200 + `text/javascript`）。教训：**往 web/ 加任何新静态资源必须同步登记 STATIC_ASSETS**。2.2.1 已重新 pack（shasum 19b77914…）并安装进 profile。
