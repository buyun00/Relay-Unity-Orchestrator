# Relay — Unity 自动化调度台

Relay 是一个运行在 Hyper-V 宿主机上的本地调度与管理系统。它把一个长期任务拆成可排队的多轮执行：没有空闲虚拟机时自动等待；工位释放后，Codex 对话、Git 分支、提交锚点和完整历史仍然保留。用户可以在同一任务中继续追加微调，而不必重新描述上下文。

## 已实现的闭环

```text
网页发起 Task / 追加 Turn
        ↓
优先级 + FIFO 自动排队
        ↓
领取兼容的空闲 Hyper-V 工位
        ↓
恢复 PROJECT_READY → 来宾 Git 准备分支 → 等待 Unity / Skill
        ↓
宿主机 Codex 在 SMB 项目路径执行（首轮创建 thread，后续 resume）
        ↓
Unity 保存 → 来宾 commit / push → 远程 SHA 核验
        ↓
恢复检查点并释放工位；Task / thread / branch 永久保留
```

如果保存、提交、推送或远程 SHA 核验失败，系统不会恢复检查点，而是把工位置为 `attention` 并保留现场，避免丢失未持久化修改。

## 快速体验（安全 Mock）

前置条件：Node.js `>= 22.13.0`。

```powershell
npm install
npm run dev
```

打开 `http://localhost:3000`。默认后端位于 `http://127.0.0.1:4317`，使用模拟项目和三台模拟工位，不会控制 Hyper-V、运行 Codex 或推送 Git。

可以创建多个任务验证排队，也可以在需求里加入 `[mock:fail=push]` 验证“推送失败后保留现场”。任务成功后打开详情并追加一轮，即可验证同一对话和分支的连续微调。

## 常用命令

```powershell
npm run dev          # 同时启动网页和控制服务
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm test             # 后端状态机测试 + 生产构建 + HTML 冒烟测试
npm run build        # 生产构建
npm start            # 启动生产构建与控制服务
```

## 切换到真实 Hyper-V

不要直接修改代码中的默认值。复制 [`.env.example`](./.env.example)，完成项目、工位、DPAPI 凭据、SMB、Unity Skill 和检查点配置后，再显式设置：

```text
PIPELINE_ADAPTER=hyperv
PIPELINE_ADMIN_TOKEN=<高强度随机令牌>
```

真实模式下，网页发出的 VM 操作只会调用 `scripts/hyperv/` 中的白名单脚本。来宾 Git 使用 PowerShell Direct；Codex 只在宿主机运行并以工位 SMB 路径作为工作目录。

完整的宿主机/子机设置、内部交换机、凭据、项目与工位字段、检查点日更策略、Windows 服务部署、canary 验收和故障处理见 [部署与运维](./docs/部署与运维.md)。

## 主要目录

- `app/`：现代化管理网页，包括任务、队列、对话、工位、项目和系统设置。
- `server/`：SQLite 持久化、调度状态机、SSE、认证、Codex 与适配器边界。
- `scripts/hyperv/`：固定参数的 Hyper-V / PowerShell Direct 操作脚本。
- `tests/server/`：不触碰真实基础设施的状态机与安全回归测试。
- `.pipeline-data/`：本地 SQLite、附件和 Codex JSONL 日志（已被 Git 忽略）。

## 核心数据模型

- **Task**：长期工作线；固定一个项目、远程分支和 Codex `thread_id`。
- **Turn**：一次需求或微调；它才是排队和调度单位。
- **Worker**：可恢复的 Hyper-V + Unity 工位；不拥有对话历史。

因此，释放或更换 Worker 不会丢掉历史。下一轮会从远程任务分支恢复代码，并通过 `codex exec resume <thread_id>` 恢复同一对话。
