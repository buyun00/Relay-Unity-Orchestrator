# 系统 Codex、自修复与 Guardian

## 目标状态

Relay 不再要求用户先发现 `attention` Worker 或手工进入桌面 Codex。控制服务会把执行失败、Worker 动作失败、健康异常、Relay 运行前置失败和 Guardian 故障记录为持久事故，并自动送入专用的“系统自动恢复”会话。网页“系统助手”同时支持多个独立人工会话。

每条会话分别保存 Codex thread、模型、推理深度和 Fast 设置。不同会话最多按 `PIPELINE_OPS_MAX_CONCURRENT_SESSIONS` 并行运行，同一会话内的轮次始终串行，所有会改变外部状态的结构化动作还会经过全局串行执行器，避免并发重启或修复相互冲突。

“清屏”会把当前最大轮次写入 `cleared_through_sequence`，只改变网页可见范围；数据库轮次、Codex thread、事故和动作审计均不会删除。需要完全独立上下文时应新建对话，而不是清屏。

Ops Codex 负责理解未知异常并组合动作；实际状态变更由 Relay 执行器完成和审计。当前动作包括：

- 在原 Task、原 Codex thread 和保留的 Worker workspace 上追加恢复消息；
- 重试或重新打开 Task；
- 探测、启动、重启、正常关闭或安全释放 Worker；
- 暂停或恢复调度器；
- 重启 Relay、网页或 Guardian；
- 启动 Relay 自身代码修复；
- 在证据已经证明恢复时关闭事故。

系统没有删除项目、任务、Worker、日志、数据库、VM、检查点、Git 分支或 worktree 的自动动作。

## attention 自动恢复

Turn 执行、Unity 保存、Git 交付或 Worker 释放失败后，原有状态机仍先把 Worker 置为 `attention` 并保留现场。Ops 引擎订阅对应错误事件并立即创建事故。对于尚未完成的 Task，系统优先追加一轮恢复指令；数据库会把新 Turn 固定回原 `attention` Worker，Scheduler 通过 `resumePreserved` 跳过检查点恢复和 Git reset。

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
PIPELINE_OPS_CODEX_MODEL=gpt-5.6-sol
PIPELINE_OPS_CODEX_REASONING_EFFORT=xhigh
PIPELINE_OPS_CODEX_FAST_MODE=false

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
- `incidents`：错误指纹、关联 Task/Turn/Worker、尝试次数和解决状态；
- `ops_actions`：每个自动动作的原因、目标、结果与错误；
- `repair_runs`：worktree、分支、基准/修复 SHA、验证、部署和回滚状态。

Codex JSONL、修复日志、Guardian 日志和 `deployment-state.json` 都位于 `PIPELINE_DATA_DIR`，服务重启后仍可继续。
