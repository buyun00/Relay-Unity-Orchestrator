# 系统 Codex、自修复与 Guardian

## 目标状态

Relay 不再为 Worker 设置人工处理状态。控制服务保留一条 GPT-5.6 Luna Max 常驻监督会话：只要存在 `queued`、`running` 或 `failed` Task，它就每 5 分钟复用同一个 Codex thread，检查 Task、JSONL、Worker、Unity、Git 和交付证据。执行失败、Worker 动作失败、健康异常、Relay 运行前置失败和 Guardian 故障仍会立即唤醒监督会话。网页“系统助手”同时支持多个独立人工会话。

每条会话分别保存 Codex thread、模型、推理深度和 Fast 设置。不同会话最多按 `PIPELINE_OPS_MAX_CONCURRENT_SESSIONS` 并行运行，同一会话内的轮次始终串行，所有会改变外部状态的结构化动作还会经过全局串行执行器，避免并发重启或修复相互冲突。

“清屏”会把当前最大轮次写入 `cleared_through_sequence`，只改变网页可见范围；数据库轮次、Codex thread、事故和动作审计均不会删除。需要完全独立上下文时应新建对话，而不是清屏。

监督 Codex 负责判断任务是在正常长耗时还是实际卡住。任务输出、验证、保存和交付问题必须用 `task.continue` 回到原 Task/Codex 对话；只有证据表明原 Codex 在启动前被基础设施阻断时，才返回 `codex.repair`，由 Relay 新建一条 GPT-5.6 Sol xhigh 修复会话。修复会话使用 `danger-full-access`，可直接使用 PowerShell Direct、本机 API、Git、Unity 端点、服务控制和源码修改，直到原 Task 恢复到可执行状态。其他兼容动作仍包括：

- 在原 Task、原 Codex thread 和保留的 Worker workspace 上追加恢复消息；
- 重试或重新打开 Task；
- 探测、启动、重启、正常关闭或安全释放 Worker；
- 暂停或恢复调度器；
- 重启 Relay、网页或 Guardian；
- 启动 Relay 自身代码修复；
- 在证据已经证明恢复时关闭事故。

每条 Task/Turn 的原始标题、用户提示词和附件引用会同步写入 `task_prompt_archive`。归档、实时提示词和 Task 删除均受 SQLite 不可变触发器保护；修复会话启动前后还会校验完整归档指纹。修复必须继续原 Task 和原 Codex thread/workspace，不能创建替代 Task 来绕过原需求。

如果修复过程中 Relay 重启，运行中的 `repair` Turn 会重新入队，并用已经持久化的修复 Codex thread 继续，而不是从头丢失现场。

## 工位自动恢复

Worker 不再有人工处理状态。任务执行、Unity 保存或 Git 交付失败后，工作区进入 `reserved`，系统把精确失败信息追加到原 Task/Codex 对话，并由 `resumePreserved` 在同一工作区继续。Codex 启动前若 VM、PowerShell Direct、SMB 或 Unity 前置条件失败，数据库保留并重新排队同一个 Turn，调度器重启对应 VM；Unity 只允许由虚拟机登录启动链恢复。若一次确定性重启仍未恢复，Worker 保持 `offline/preparing`，由基础设施守护链继续执行结构化 `worker.restart`，不会转成人工门禁。

常驻 Supervisor 还会用确定性规则扫描工位占用：`reserved`、`preparing` 或 `busy` 工位若连续 15 分钟没有一个真正执行中的 Turn，持久记录 `worker.occupancy.stalled` 事件并且只为该工位拉起去重的 Ops Incident。正常 `ready` 空闲和正常长时间 Turn 不会触发。监控对话必须先只读确认最后 Turn、分支、HEAD 和工作树；只有工作树干净且结果已持久化时才能 `worker.release`。单纯 probe 不算恢复，未恢复的 Incident 会在阈值后继续同一监控链。

队列活性是独立的强制约束：只要仍有 queued Turn，调度器为 paused/stopped 就立即记录 `scheduler.queue.stalled`；调度器虽在运行但连续 5 分钟没有任何 executing Turn 也记录同类事故。该事故必须进入同一条常驻监控对话，自动恢复不得在仍有队列时执行 `scheduler.pause`，而 `scheduler.resume` 只有在后续 `turn.prepare` 或 `turn.resume` 证明原队列开始消费后才算恢复。Worker 暂时仍不可用时事故保持 monitoring，并按 Supervisor 周期继续复查，不受普通事故最大尝试次数终止。

Relay 后端重启时，运行中的原 Turn 也会直接重新排队，Worker 暂记 `offline` 并在健康探测通过后回到 `ready`。旧数据库中的历史人工状态会在启动时归一化为 `offline`。

如果交付已经持久化，只是释放失败，Ops Codex 可以调用 `worker.release`。相同事故的自动尝试受 `PIPELINE_OPS_MAX_ATTEMPTS` 限制，避免无穷循环；新的错误证据会重新打开正在监控的事故。

## Relay 自修复和自进化

当 Ops Codex 返回 `relay.repair` 时，Repair Manager：

1. 要求当前 Relay 源码 worktree 干净，并记录基准 SHA。
2. 在 `PIPELINE_DATA_DIR\repairs\<repair-id>` 创建独立 Git worktree 和 `relay/auto-repair-*` 分支。
3. 在隔离目录以 `workspace-write` 启动 Repair Codex。它可修改代码、配置、脚本、测试和文档，但不能改写源 worktree 或宿主机其他目录。
4. 分别审计已提交、未提交和暂存差异；任何文件删除都会以 `REPAIR_DELETION_FORBIDDEN` 拒绝。
5. 如果 Codex 没有自行提交，由 Relay 使用仓库级作者信息创建自动修复提交。
6. 独立执行 TypeScript 检查、全部 server tests、生产构建和 rendered HTML 测试。
7. 再次确认主 worktree 没有并发修改且仍位于基准 SHA，然后 `--ff-only` 切换到修复提交。
8. 写入 `deployment-state.json`，通知 Guardian 构建主目录并重启 Relay 和网页。
9. Guardian 等待两个服务恢复健康；如果启动或健康检查失败，自动创建 Git revert 提交、重新构建并拉起旧版本。

修复 worktree 和 Git 历史会保留用于审计，不会被自动删除。

## Relay 与 Guardian 相互守护

Relay 内的 `GuardianClient` 定期检查 `http://127.0.0.1:4318/api/health`。连续失败达到阈值后，它会用隐藏窗口启动独立 `server/guardian.mjs`。

Guardian 以独立 Node 进程运行，定期检查：

- Relay API：`http://127.0.0.1:4317/api/health`
- 生产网页：`http://127.0.0.1:3000/`

连续失败达到阈值后，Guardian 只会停止命令行明确匹配 Relay 入口的端口所有者，然后重新拉起对应服务。它不会停止未知进程。

生产网页的 `/relay-control/api` 代理在 Relay 连接失败时会自动回退到 Guardian。Guardian 提供兼容的 `/api/health`、`/api/snapshot`、`/api/events` 和 `/api/ops/messages`，所以 HTTPS 网页仍能显示恢复模式并发送 Emergency Codex 消息。即使网页也不可用，仍可直接打开：

```text
http://<宿主机>:4318/
```

Emergency Codex 可重启 Relay/网页，也可复用同一个隔离修复、验证、提交、部署和回滚流程。

## 配置

默认配置已经启用完整闭环：

```dotenv
PIPELINE_OPS_ENABLED=true
PIPELINE_OPS_AUTO_HANDLE=true
PIPELINE_OPS_AUTO_DEPLOY=true
PIPELINE_OPS_MAX_ATTEMPTS=4
PIPELINE_OPS_MAX_CONCURRENT_SESSIONS=4
PIPELINE_OPS_SUPERVISOR_INTERVAL_MS=300000
PIPELINE_OPS_WORKER_OCCUPANCY_STALL_MS=900000
PIPELINE_OPS_QUEUE_LIVENESS_STALL_MS=300000
PIPELINE_OPS_CODEX_MODEL=gpt-5.6-luna
PIPELINE_OPS_CODEX_REASONING_EFFORT=max
PIPELINE_OPS_CODEX_FAST_MODE=false
PIPELINE_OPS_REPAIR_CODEX_MODEL=gpt-5.6-sol
PIPELINE_OPS_REPAIR_CODEX_REASONING_EFFORT=xhigh
PIPELINE_OPS_REPAIR_CODEX_FAST_MODE=false
PIPELINE_OPS_REPAIR_CODEX_TIMEOUT_MINUTES=0
PIPELINE_OPS_REPAIR_TASK_START_WAIT_MS=120000

PIPELINE_GUARDIAN_ENABLED=true
PIPELINE_GUARDIAN_HOST=0.0.0.0
PIPELINE_GUARDIAN_PORT=4318
PIPELINE_GUARDIAN_INTERVAL_MS=5000
PIPELINE_GUARDIAN_FAILURE_THRESHOLD=3
PIPELINE_GUARDIAN_RESTART_COOLDOWN_MS=20000
```

`PIPELINE_GIT_COMMAND` 可以指定 Git 可执行文件。未指定且 `git` 不在 `PATH` 时，Repair Manager 和 Guardian 会自动查找 Codex bundled Git。

## 启动和开机恢复

正常启动 Relay 时，后端会自动保证 Guardian 存在：

```powershell
npm run build
npm start
```

也可以单独运行恢复平面：

```powershell
npm run start:guardian
```

要让 Guardian 在 Windows 开机时以 `SYSTEM`、最高权限和失败自动重启方式运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\Install-RelayGuardianTask.ps1
```

安装脚本会按本机约定直接触发 UAC 提权，注册并启动 `Relay Unity Guardian` 计划任务。Guardian 和 Relay 后续仍会继续相互探活。

## 持久数据

SQLite 新增以下记录：

- `ops_threads`：每条系统 Codex 对话的持久 `thread_id`、标题、模型配置和非破坏清屏位置；
- `ops_turns`：手工消息、自动事故轮次和结构化结论；
- `task_prompt_archive`：Task 标题、每一轮原始用户提示词和附件引用的不可变副本；
- `incidents`：错误指纹、关联 Task/Turn/Worker、尝试次数和解决状态；
- `ops_actions`：每个自动动作的原因、目标、结果与错误；
- `repair_runs`：worktree、分支、基准/修复 SHA、验证、部署和回滚状态。

Codex JSONL、修复日志、Guardian 日志和 `deployment-state.json` 都位于 `PIPELINE_DATA_DIR`，服务重启后仍可继续。
