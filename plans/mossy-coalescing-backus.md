# 本地 Board Maintainer 自动审查 + ak-verify Skill + Skills 管理页

## Context

用户纯本地部署 agent-kanban（Hono dev server + 本地 D1 + `ak start` local daemon），不用 AMA、不用 Cloudflare。当前 in_review 任务只能人工 complete/reject，依赖链全堵（实际发生：#3 进 review 后 #1/#2/#4/#5/#6 全 blocked）。

五个工作流（已与用户确认决策）：
- **W1** Post-Write Workflow → 独立新 skill `ak-verify`
- **W2** Skills 独立管理页（与 Agents/Machines 同级导航；完整闭环：D1 存储 + UI 编辑 + daemon 安装通道；内置只读 + 自定义可编辑）
- **W3** Repositories 从头像下拉移到顶部导航（路由已存在，纯导航调整）
- **W4** 本地 maintainer 正式代码支持（server 路由分支 + CLI maintainer 提示词分支）
- **W5** 触发器：SSE 事件驱动 + 定时轮询兜底（两者结合）

## AMA maintainer 源码分析结论（用户要求的研究，来自 saltbo/any-managed-agents）

Maintainer 在 AMA 侧的「有效运行包」= 本地复刻清单：

1. **Agent 定义**：AMA `AgentSpec` 只有 systemPrompt(=AK agent 的 soul)/provider/model/skills/subagents；AK 发的 memoryPolicy/handoffPolicy 是**死字段**（AMA 严格 schema 直接丢弃）。maintainer skill `saltbo/agent-kanban@ak-maintainer` 由 AK 端 `withMaintainerSkill` 强制加入（routes.ts:2683）
2. **Skills 加载**：runner 在 session worktree 里跑 `npx skills add <source> --skill <name> --agent claude-code -y`（与 AK 本地 daemon 的 `ensureSkills` 同一机制）；skill 变更时 user prompt 前会加刷新通知
3. **System prompt** = soul + `## Agent Capabilities`（Skills 列表 + subagents 列表）
4. **User prompt**：心跳 = 固定 5 行模板（board id + 遵循 ak-maintainer skill + 读写 HEARTBEAT.md + "Run type: scheduled heartbeat"）；GitHub 事件 = LiquidJS 渲染模板（新 session 全量简报 / 复用 session 仅事件字段）
5. **触发**：CF Worker cron（每分钟扫 due 的 schedule trigger）+ HTTP trigger（serial 并发，routing_key 按 issue/PR 复用 session）
6. **Memory**：D1 同步的文件目录，挂载到 `<cwd>/.ama/memory-stores/<id>`，agent 用普通文件工具读写 HEARTBEAT.md，run 结束后全量回写。**本地等价物 = 一个 per-board 持久目录**
7. **Env**：`AK_WORKER/AK_AGENT_ID/AK_BOARD_ID/AK_MAINTAINER_ID/AK_API_URL` + vault 里 `ak-variables`/`user-variables` 批量投射（含 maintainer 权限的 AK_API_KEY）
8. **Tools**：claude-code 全部能力（bypassPermissions）；`allowedTools:[]` 只约束 AMA 自家 sandbox runtime
9. **Session 语义**：routing_key 复用 + resume token + 事件消息注入 live session + idle timeout 关闭

**本地复刻结论**：1/2/3/7 本地 daemon 已有等价物（ensureSkills、systemPrompt、buildAgentEnv）；4/5 由 W5 触发脚本 + 任务描述承担；6 用持久目录 + 任务描述约定（v1 无需代码）；9 的 reject-resume 本地已有（checkRejectedReviews）。

## W1 — skill `skills/ak-verify/`

- NEW `skills/ak-verify/SKILL.md`：frontmatter `name: ak-verify` + 触发式 description（"Use after non-trivial code change / as acceptance standard when reviewing others' changes; not for trivial/docs-only"）
- **角色化翻译**（可移植性核心，不硬编码本仓库 Claude Code subagent 名）：
  - Author（编排+唯一改源码）/ Test author（写跑单测）/ E2E author（仅前端变更时）/ Reviewer（clean-code PASS/REVISE）
  - 映射说明：有 subagent 的运行时委派独立 subagent；单 agent 运行时按序切换角色，review 遍不省略
- 三步：Tests（失败分诊 source-bug vs test-bug；**ownership rule**：Author 只改源码，测试改动走 test 角色）→ Review（REVISE 分流）→ Regression（从仓库自身配置发现命令；示例 `pnpm build && pnpm typecheck && npx vitest run`；保留 solution-style tsconfig 根 tsc 无效的警示）
- "Project-specific steps" 钩子：引导读仓库 CLAUDE.md/AGENTS.md 的补充检查（本仓库 daemon smoke 留在 CLAUDE.md）
- 维护者视角一节：review 他人改动时，Step 1/3 作为验证证据、Step 2 即审查，结论映射 accept/reject
- EDIT `skills/ak-maintainer/SKILL.md`：Pull Request Acceptance 下加一段——安装了 ak-verify 时以其为验收标准
- EDIT `CLAUDE.md`：Post-Write Workflow 正文替换为指向 skill + 保留 daemon smoke 本地步骤

## W2 — Skills 管理（页 + 存储 + daemon 安装通道）

后端：
- NEW `apps/web/migrations/0043_skills.sql`：`skills(id, owner_id, name, description, body, created_at, updated_at)`，UNIQUE(owner_id, name)；v1 单文件（name/description/body），references 多文件留 v2
- NEW `apps/web/server/skillRepo.ts`（仿 repositoryRepo.ts）
- EDIT `apps/web/server/routes.ts`：`/api/skills` CRUD + `GET /api/skills/by-name/:name/content`（**允许 machine 身份**——daemon 拉取用）；`GET /api/skills/builtin` 读仓库 `skills/*/SKILL.md`（fs 读取，不可用时优雅返回 []；本地部署可用）
- EDIT `packages/shared/src/types.ts`：`Skill` 类型；放宽 `SKILL_REF_RE`（types.ts:235）接受本地 ref 格式 **`ak@<name>`**；`findInvalidSkillRef` 同步
- AMA 兼容：AMA dispatch 路径（taskDispatch.ts buildAmaAgentInput）过滤 `ak@` refs 并 log（AMA 无法解析）

前端：
- EDIT `apps/web/src/lib/api.ts`：`api.skills.{list,get,create,update,delete,getContent,listBuiltin}`
- NEW `apps/web/src/hooks/useSkills.ts`（仿 useRepositories.ts，query key `["skills"]`）
- NEW `apps/web/src/routes/SkillsPage.tsx`（仿 RepositoriesPage 结构：`max-w-4xl` 容器 + 头行 + Tabs[Built-in 只读 / Custom 可编辑] + Dialog 编辑器：name/description/body textarea，sonner toast；遵循 DESIGN.md：Geist Mono 数据字体、cyan accent 仅交互元素、骨架屏 loading）
- EDIT `apps/web/src/components/Header.tsx`：navLinks（16-19 行）加 `/skills`（同时加 `/repositories`，见 W3）
- EDIT `apps/web/src/App.tsx`：`/skills` 路由（ProtectedRoute，仿 /agents 129-136 行）
- Agent 编辑页（AgentEditPage/AgentNewPage 的 TagInput）：校验改用放宽后的 findInvalidSkillRef，placeholder 提示支持 `ak@name`

CLI/daemon：
- EDIT `packages/cli/src/workspace/skills.ts`：`ensureSkills` 识别 `ak@<name>` → 经 API 拉 content → 写 `.claude/skills/<name>/SKILL.md`（frontmatter 由 name/description 重建）；dispatcher.ts:310 调用处把 client 传入（新参数）

## W3 — Repositories 导航上移

- EDIT `apps/web/src/components/Header.tsx`：navLinks 加 `{ to: "/repositories", label: "Repositories" }`；删除头像下拉的 Repositories 项（190-204 行）
- 注意：`routes.ts:3020` GitHub App 安装后重定向 `/repositories?app_installed=1` —— 路由不变，无影响

## W4 — 本地 maintainer 代码支持

Server（`apps/web/server/routes.ts` POST /api/boards/:id/maintainers, 2241 行起）：
- `amaConfigured = isAmaTaskDispatchConfigured(c.env)`；仅 AMA 时 `requireAmaConnected`
- 新增 `ensureLocalMaintainerAgentProfile`：校验（worker + isMaintainerAgentProfile）+ `withMaintainerSkill`，**不加 NoSchedule taint**（注释说明：taint 是为防 AMA maintainer 被 legacy 调度；本地 daemon 需要调度它，加了会永久 schedulable=false）
- 非 AMA 分支：`createBoardMaintainer` 直接建行，`amaScheduleId: "local:<id>"`（NOT NULL 占位、自描述）、http/memory/apiKey=null、`heartbeatEnabled=false`（本地无服务端调度器）、prompt=""
- AMA 路径逐行不动；分支只激活在原必 500 处
- EDIT `boardMaintainerRepo.ts:30-44`：`CreateBoardMaintainerInput.amaHttpTriggerId/amaMemoryStoreId` → `string | null`（匹配 0035 migration schema）
- PATCH/DELETE/runs/variables 端点保持 AMA-only（v1 文档说明）

CLI（`packages/cli/src/agent/systemPrompt.ts`）：
- `AgentInfo` 加 `skills?: string[] | null`（dispatcher.ts:338 已传全量 agent）
- maintainer 检测：`role === "board-maintainer" || skills 含 ak-maintainer`
- maintainer 会话把 DEV_RULES/OPS_RULES 里 "Never call task complete" 换成 maintainer 规则：complete/reject 是本职工作（agent:maintainer 身份）；不审自己实现的任务；自己的审查任务完成后 `ak task review` + `ak task complete` 自清（解决审查任务自身的无限递归）

## W5 — 触发脚本（SSE + 轮询结合）

NEW `scripts/local-maintainer-watch.sh`（bash + ak CLI + jq + curl）：
- **watch 模式（默认，长驻）**：`curl -N` 监听 `GET /api/boards/:id/stream`，收到 `review_requested` 动作→触发；SSE 25s 窗口断开重连；**每次重连 + 每 2 分钟兜底做一次全量轮询**（覆盖断连期间漏掉的事件）
- **--once 模式**：单次轮询（cron `*/2 * * * *` 备选）；脚本头注释给 cron 和 systemd user unit 两种安装示例
- 触发逻辑（两种模式共用）：daemon 不在（`ak status`）→退；无 in_review→退；**去重**：该 maintainer agent 已有 todo/in_progress/in_review 的 `maintainer-review` 标签任务→退
- 创建审查任务：**dev board + repository_id**（有 worktree，可 `gh pr checkout` 跑 ak-verify 回归）+ `--labels maintenance,maintainer-review`
- 任务描述含：待审任务清单（id/标题/PR url）、遵循 ak-maintainer + ak-verify、**熔断**（已被拒 ≥2 次→留 note 升级人工不再 reject）、PR 2 分钟内有更新则跳过本轮、**记忆目录约定** `~/.local/share/agent-kanban/maintainer/<boardId>/HEARTBEAT.md`（AMA memory 的本地等价物）

## Maintainer agent 创建（用户操作，基于 AMA 分析的配置清单）

Agents 页 New agent（或 `ak create agent` / `ak apply`）：
- name: Board Maintainer，role: `board-maintainer`，kind: worker，runtime: claude，model: k3-256k（走 Kimi relay）
- skills: `["saltbo/agent-kanban@ak-maintainer", "ak@ak-verify"]`（W2 完成后；或先用 GitHub ref）
- **不加任何 taint**
- soul：按 ak-maintainer skill 的 Mission 改写（审查 PR/triage/质量门禁/记忆纪律）
- 然后 `ak create maintainer --board <id> --agent <id>`（W4 后本地可用）→ `ak get maintainer` 确认 active 且 agent `status.schedulable=true`

## 关键文件清单

| 工作流 | 文件 |
|---|---|
| W1 | `skills/ak-verify/SKILL.md`(新)、`skills/ak-maintainer/SKILL.md`、`CLAUDE.md` |
| W2 | `apps/web/migrations/0043_skills.sql`(新)、`server/skillRepo.ts`(新)、`server/routes.ts`、`packages/shared/src/types.ts`、`src/lib/api.ts`、`src/hooks/useSkills.ts`(新)、`src/routes/SkillsPage.tsx`(新)、`src/components/Header.tsx`、`src/App.tsx`、`packages/cli/src/workspace/skills.ts` |
| W3 | `src/components/Header.tsx` |
| W4 | `apps/web/server/routes.ts`、`apps/web/server/boardMaintainerRepo.ts`、`packages/cli/src/agent/systemPrompt.ts` |
| W5 | `scripts/local-maintainer-watch.sh`(新) |

## 实施顺序

W1 → W3（小）→ W2（最大）→ W4 → W5 → 用户设置（建 agent + create maintainer + 装 watcher）→ 端到端验证

注意：另一个 AK worker session 正在本仓库跑 "commit code" 任务（relay 改动集），已告知其我们不会动源码；**实施前先确认其 commit 完成并 pull/rebase**。

## 测试（按 Post-Write Workflow）

- 单测（tests/*.test.ts，无 Miniflare）：SKILL_REF_RE 放宽 + findInvalidSkillRef；skillRepo CRUD；/api/skills 路由（含 machine 读 content）；maintainers POST 非 AMA 分支建行且无 taint；generateSystemPrompt maintainer vs worker 规则；skills.ts `ak@` 安装（mock fetch）
- E2E（Playwright，前端变更触发 playwright-test-generator）：Skills 页 CRUD + 内置只读展示；顶部导航出现 Skills/Repositories；Repositories 下拉项移除
- 回归：`pnpm build && pnpm typecheck && npx vitest run`
- `packages/cli/src/daemon/` 未直接改（只动 workspace/skills.ts），但谨慎起见跑 `./scripts/daemon-smoke-test.sh`（先 `bash scripts/install-cli.sh`）

## 端到端验证（全本地）

1. 起 dev server + `ak start --mode local`
2. 建 maintainer agent（上述配置）→ `ak create maintainer` → active 且 schedulable
3. Happy path：worker 任务进 in_review → watch 脚本触发 → daemon 调度审查任务 → 任务自动 done，依赖链解锁
4. Reject 闭环：造一个测试失败的任务 → maintainer reject → daemon checkRejectedReviews resume worker → 修复重交 → maintainer complete
5. 熔断：连续 2 次 reject → 第 3 轮留 note 升级人工
6. 去重：审查任务活动期间重复触发脚本 → 不产生第二个审查任务
7. UI：Skills 页新建自定义 skill（ak@my-skill）→ 挂到 agent → dispatch 后工作区 `.claude/skills/my-skill/SKILL.md` 存在
8. AMA 回归：现有 maintainer 路由测试（AMA 配置路径）全绿
