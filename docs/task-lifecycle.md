# 看板任务生命周期

本文档解释 Agent Kanban 看板五个栏目（Todo / In Progress / In Review / Done / Cancelled）之间的逻辑关系：状态如何流转、由谁触发、以及调度系统在每条边上扮演的角色。面向需要理解系统行为的用户与维护者。

状态机权威实现见 `packages/shared/src/taskStateMachine.ts`；本文档与代码保持一致，如有出入以代码为准。

## 一、五个栏目的含义

| 栏目 | 含义 |
|------|------|
| **Todo** | 待处理。任务已创建，等待被派发（已指派 agent）或被认领。这是任务的"排队"状态。 |
| **In Progress** | 进行中。某个 agent 已原子认领（claim）该任务，正在其工作区中执行。同一时刻一个任务只被一个 agent 持有。 |
| **In Review** | 待评审。agent 完成工作并提交评审（通常附带 PR 或本地分支）。等待 reviewer（人类或 leader agent）裁决。 |
| **Done** | 已完成。reviewer 接受（complete）任务。终态。 |
| **Cancelled** | 已取消。任务在 Todo / In Progress / In Review 任一阶段被取消。终态。 |

### 为什么没有 Failed 栏目？

这是有意的设计：系统不区分"失败"作为一种终态。失败通过两条已有路径表达：

- **可恢复失败**（崩溃、限流、配额耗尽）→ 任务经 **release** 回到 **Todo** 等待重试，或保持 **In Progress**（会话挂起、额度恢复后带上下文续跑）。
- **不可恢复/不再要做** → **Cancelled**。

这样做的好处是看板只表达"工作的位置"，不积累"失败的原因"；原因记录在任务日志（task logs）中，而不是状态里。

## 二、状态转移表

每条边标注：触发动作 → 目标状态｜允许的身份｜触发机制。

| 从 | 动作 | 到 | 允许的身份 | 机制 |
|----|------|----|-----------|------|
| Todo | **claim** | In Progress | agent:worker | agent 通过 `db.batch()` 原子认领，杜绝并发竞争（taskRepo.ts）。本地运行时由 daemon 派发后 agent 自行 claim。 |
| In Progress | **review** | In Review | agent:worker | agent 完成工作，提交评审并附 PR URL（或本地分支说明）。 |
| In Review | **reject** | In Progress | user、agent:leader、agent:maintainer | reviewer 打回。daemon 检测到拒绝后**带上下文唤醒原会话**继续修改（不是重新派发）。 |
| In Review | **complete** | Done | user、machine、agent:leader、agent:maintainer | reviewer 接受。此外两条自动路径：PR 合并的 GitHub webhook、daemon 的 prMonitor 检测到 PR MERGED。 |
| Todo / In Progress / In Review | **cancel** | Cancelled | user、machine、agent:leader、agent:maintainer | 任意非终态可取消。对进行中的任务，daemon 每轮检查并杀死对应会话；关联 PR 被 CLOSED 时也会自动取消。todo 也可取消——否则已指派的任务会被扫描反复重新派发。 |
| In Progress | **release** | Todo | machine、agent:leader、agent:maintainer | 释放回队列。三条触发路径：① 24h stale 扫描（agent 失联，写时检测，幂等）；② daemon 处理崩溃/退出后任务仍挂起时主动释放；③ 恢复时发现 worktree 已丢失。 |

身份的三种来源：**user**（浏览器会话）、**machine**（API key，daemon 使用）、**agent**（Ed25519 JWT，分 worker / leader / maintainer 三种角色）。

### 关于 blocked（非状态）

`blocked` 不是栏目也不是状态，而是**读取时计算**的属性：任务的 `depends_on` 依赖数组中有任何一个未完成，任务即 blocked（taskDeps.ts，递归 CTE 检测循环依赖）。blocked 的 todo 任务不会被本地 daemon 派发。依赖全部完成后，任务自动变为可派发——无需任何状态转移。

## 三、本地调度循环的门槛（Todo → 实际执行）

任务处于 Todo 且已指派 agent，并不意味着立即执行。本地 daemon 的调度循环（dispatcher.ts）每轮依次检查全部门槛：

1. **blocked** — 依赖未完成，跳过。
2. **scheduled_at** — 定时任务未到点，跳过。
3. **并发上限** — 该 runtime 的活动会话数达到 `maxConcurrent`，跳过。
4. **agent 可调度性** — agent 存在、有 runtime、服务端标记 schedulable。
5. **runtime 可用性**（配额感知）— provider 的 `checkAvailability` 必须为 ready：
   - 官方 Claude（OAuth）：查询 Anthropic usage API，5h/7d 窗口用量 ≥100% → limited，附带 resets_at。
   - **Kimi 中继**：查询 `/coding/v1/usages`，5 小时与 7 天窗口任一耗尽 → limited 至该窗口 resetTime。
   - **DeepSeek 中继**：余额为零/不可用 → limited（1 小时后合成重探）；**峰价时段内**（可配置的峰谷窗口，默认北京时间 09:00–12:00、14:00–18:00）→ limited 至下一谷时起点。
   - limited 状态经心跳上报服务端，服务端同步将该 runtime 标记为不可调度（双重门槛）。
6. **rate limiter / 熔断器** — 该 runtime 处于限流暂停或熔断期，跳过。
7. **worktree 互斥** — 关闭了 worktree 的任务直接在仓库检出目录工作，同一仓库目录同时只允许一个此类任务（worktree 任务无此限制——它们各自在独立分支与目录中工作）。

通过全部门槛后，daemon 准备工作区并派生 agent 会话。

## 四、中断与恢复：崩溃、限流、配额挂起

运行中的会话由 daemon 的会话状态机管理（active → rate_limited / in_review / completing → closed）。三类中断的行为：

### 崩溃（可恢复错误）
网络抖动、5xx 等 transient 错误：会话进入挂起，30 秒退避后自动带上下文恢复（resume）。不可恢复错误（401、404 等 terminal）：任务 release 回 Todo，工作区保留，由后续派发接手。

### 限流（rate limit 事件）
provider 上报 rate_limit 事件：daemon 记录 resumeAfter（窗口重置时间），会话挂起，**任务保持 In Progress**；窗口重置后原会话带完整上下文续跑（"Rate limit window has reset. Continue where you left off."），不重新派发、不丢工作。

### 配额耗尽（中继 403/429）
Claude Code 指向 Kimi/DeepSeek 中继时，API 在配额耗尽时返回 403/429。daemon 将其识别为**配额挂起**而非崩溃：

- 429 优先采用响应的 Retry-After；否则取用量快照中耗尽窗口的 resets_at（如 Kimi 5h 窗口的重置时刻）；都没有则回退 30 分钟后重试。
- 会话进入挂起，任务保持 In Progress，额度恢复后自动续跑。
- 401 例外：密钥被吊销不是窗口问题，仍按 terminal 处理（任务 release 回 Todo）。
- 同一会话连续挂起 5 次后按 terminal 处理（release 回 Todo）——防止永久性 403（套餐/区域/模型限制）无限重试空耗；会话成功进入 In Review 时计数清零。

## 五、Worktree 生命周期与本地仓库

### Worktree 任务（默认）

创建任务时默认开启隔离 worktree（可在任务表单中关闭，或自定义名字；留空则随机生成形如 `ak-<adjective>-<noun>-<hex>` 的名字）。派发时 daemon 在仓库中创建 `ak/<name>` 分支与对应的 git worktree 目录，agent 在其中工作：

- 多个 agent 可在同一仓库的不同 worktree 中**并行**工作，互不干扰。
- 评审期间 worktree 保留（供 reject 后续跑、reviewer 查验）；任务 Done/Cancelled 后由 daemon 清理目录与分支。
- 关闭 worktree 的任务直接在仓库检出目录工作（每仓库同时仅一个此类任务，含挂起中的会话），daemon 不做任何清理；远程仓库的直接任务开始前会把检出重置到默认分支最新提交（stash + checkout + pull --ff-only），本地仓库则完全不被动。

### 本地仓库

注册仓库时除 GitHub URL 外，也支持本机绝对路径（如 `/home/you/Security-agent`）。本地仓库：

- 不克隆、不 stash、不 pull——daemon 绝不动用户的工作区；worktree 直接基于当前 HEAD 在原仓库中创建。
- agent 在 `ak/<name>` 分支上提交；**无 PR 流程**（跳过推送与 PR 步骤），完成说明中注明分支名，由 reviewer 在本地合并（`git merge ak/<name>`）。
- 评审与状态流转与远程仓库任务完全一致。
- 路径在每台运行 daemon 的机器上按字面解释——自托管单机部署无影响；若同一账号在多台机器上运行 daemon，需保证路径在各机器上指向同一项目。

## 六、一页速览

```
                 claim                review
  ┌──────┐  (agent 原子认领)  ┌─────────────┐  (agent 提交)  ┌───────────┐
  │ Todo │ ────────────────▶ │ In Progress │ ─────────────▶ │ In Review │
  └──────┘                   └─────────────┘                └───────────┘
    ▲                             │   ▲                          │  │
    │         release             │   │         reject           │  │ complete
    │  (stale 24h/崩溃/worktree丢失) │   └──────────────────────────┘  │ (reviewer/PR合并)
    └─────────────────────────────┘                                 ▼
                                                              ┌──────────┐
        cancel（任意非终态，user/machine/leader/maintainer）─▶ │Cancelled │
        complete 的终态 ──────────────────────────────────▶  │  Done    │
                                                              └──────────┘

In Progress 的中断：限流/配额(403·429) → 会话挂起、任务不动、窗口重置后续跑
```
