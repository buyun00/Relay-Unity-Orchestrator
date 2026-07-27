# Relay — Unity 自动化调度台

Relay 是一个运行在 Hyper-V 宿主机上的自建调度与管理系统，不依赖 Sites 或其他托管网页服务。它把一个长期任务拆成可排队的多轮执行：没有空闲虚拟机时自动等待；工位释放后，Codex 对话、Git 分支、提交锚点和完整历史仍然保留。用户可以在同一任务中继续追加微调，而不必重新描述上下文。

Relay 同时内置持久化“系统助手”。任务、Worker、Git 交付、Relay 进程或网页出现异常时，系统会自动创建事故并唤醒专用 Ops Codex；它可以继续保留中的任务、探测或重启 Worker、控制调度器、拉起服务，并在判断为 Relay 自身缺陷时进入隔离 Git worktree 完成修复、全量验证、提交、部署与失败回滚。网页还可创建多个相互独立、可并行运行的人工对话，每条对话分别保存 Codex thread、模型、推理深度与 Fast 设置。清屏只隐藏当前对话的已有轮次，不删除 Codex 上下文或审计记录。自动动作不提供删除数据的入口。独立 Guardian 与 Relay 相互探活和拉起，主 API 不可用时仍可从 Guardian 恢复页继续与 Emergency Codex 对话。

完整权限边界、数据模型、恢复流程和部署方式见 [`docs/系统Codex与Guardian.md`](./docs/系统Codex与Guardian.md)。

## 已实现的闭环

```text
网页发起 Task / 追加 Turn
        ↓
优先级 + FIFO 自动排队
        ↓
领取兼容的空闲 Hyper-V 工位
        ↓
确保真实 VM / PowerShell Direct 可用 → 来宾 Git 准备分支 → 等待 Unity / Skill
        ↓
宿主机 Codex 在 SMB 项目路径执行（首轮创建 thread，后续 resume）
        ↓
Unity 保存 → 来宾 commit / push → 远程 SHA 核验
        ↓
释放工位；启用检查点后可恢复 PROJECT_READY；Task / thread / branch 永久保留
```

如果保存、提交、推送或远程 SHA 核验失败，系统不会恢复检查点，而是把工位置为 `attention` 并保留现场，避免丢失未持久化修改。

## 网页使用说明

### 1. 连接控制服务

打开 `http://localhost:3000`；从其他局域网设备访问时，将 `localhost` 换成宿主机 IP。局域网 HTTP 网页默认连接同一主机的 `4317` 端口；HTTPS/Cloudflare 页面通过网页生产服务的同源 `/relay-control/api` 代理连接，避免浏览器混合内容和单独 API 隧道的传输延迟。首次进入只需填写使用者名称，不需要访问令牌或密码；名称保存在当前浏览器中，并记录到任务发起人、每轮消息作者和人工操作事件里，方便多人共用时区分使用者。

首次使用前应在“项目”页添加项目环境，并在“工位”页添加和启用至少一个兼容的 Hyper-V 工位。系统页应显示控制服务实时连接正常、Codex 已登录且调度器未暂停。

### 2. 发起新任务

在首页或任务页点击“发起新任务”：

1. 填写任务内容、复现步骤和验收标准。可添加图片、文本、日志，也可直接把截图粘贴到输入框。
2. 在“Codex 配置”中选择模型和思考深度，并决定是否开启 Fast 模式。
3. 选择优先级和交付后是否自动释放工位。
4. 点击“加入执行队列”。

新任务默认使用：

- 模型：`GPT-5.6 Sol`（`gpt-5.6-sol`）
- 思考深度：`Extra High`（`xhigh`）
- 速度：普通速度，Fast 模式关闭

这三个选项保存在任务记录中。首轮执行和以后追加的所有轮次都会沿用相同设置，不会因为服务重启或更换工位而变化。模型支持的思考深度不同，切换模型时网页会自动收窄可选范围；Fast 只影响该任务，不修改全局默认值。

### 3. 查看进度与继续任务

任务进入队列后，可以在任务详情中查看队列位置、当前阶段、Codex 输出、附件、Git 分支和每一轮历史。任务处于排队、执行、失败现场保留或关闭状态时都可以继续发送消息；系统会按顺序执行，不会并发修改同一分支。失败现场上的下一轮固定续用原工位并跳过检查点还原和 Git 重置；其他后续轮次会恢复同一个 Codex 对话和任务分支，不需要重新描述全部上下文。

常见状态：

- “等待空闲工位”：任务已排队，尚未分配兼容工位。
- “准备工位 / 执行中”：系统正在准备 VM 或运行 Codex、Unity、Git 流程。
- “已交付”：本轮已保存、提交、推送并通过远程 SHA 核验。
- “需要处理”：自动交付未能安全完成，系统保留工位现场，不会自动恢复检查点。先在任务日志和工位详情中排查，再手动重试或释放。

系统页的“暂停领取新轮次”只会阻止开始新的排队任务，不会中断正在执行的工作。取消正在执行的轮次会立即停止执行并保留现场，使用前请确认不再需要自动保存和推送。

## 在 Hyper-V 宿主机启动

前置条件：Node.js `>= 22.13.0`、Hyper-V 管理权限、已登录的 Codex CLI。控制服务不再包含生产 Mock，也不会自动创建示例项目或工位。

```powershell
npm install
Copy-Item .env.example .env.local
# 编辑 .env.local，设置 CODEX_HOME 和允许的网页 Origin
npm run dev
```

打开 `http://localhost:3000`。启动时控制服务会读取真实 Hyper-V VM 清单，并检查 Codex CLI 版本和登录状态；任一前置检查失败时调度器会保持暂停，具体原因可在系统页或 `/api/runtime` 查看。

检查点尚未准备好时保持 `PIPELINE_CHECKPOINTS_ENABLED=false`。此阶段任务开始前只确保 VM 与 PowerShell Direct 可用，交付后不会调用快照恢复；下一次分配前会把受管 Git 工作区重置到目标远端分支并清理未跟踪文件。

## 常用命令

```powershell
npm run dev          # 同时启动网页和控制服务
npm run lint         # ESLint
npm run typecheck    # TypeScript
npm test             # 后端状态机测试 + 生产构建 + HTML 冒烟测试
npm run build        # 生产构建
npm start            # 启动生产构建与控制服务
npm run start:guardian # 单独启动 Guardian 恢复平面
powershell -ExecutionPolicy Bypass -File .\scripts\Restart-RelayWeb.ps1
# 仅重启网页服务，并确保 3000 端口运行生产构建而不是 vinext dev
```

## 真实宿主机配置

生产路径固定使用 Hyper-V。复制 [`.env.example`](./.env.example)，完成项目、工位、DPAPI 凭据、SMB 和 Unity Skill 配置：

```text
PIPELINE_ADAPTER=hyperv
PIPELINE_CHECKPOINTS_ENABLED=false
```

真实模式下，网页发出的 VM 操作只会调用 `scripts/hyperv/` 中的白名单脚本。来宾 Git 使用 PowerShell Direct；Codex 只在宿主机运行并以工位 SMB 路径作为工作目录。

准备好 `PROJECT_READY` 后再将 `PIPELINE_CHECKPOINTS_ENABLED` 改为 `true`。完整的宿主机/子机设置、内部交换机、凭据、项目与工位字段、检查点日更策略、Windows 服务部署、canary 验收和故障处理见 [部署与运维](./docs/部署与运维.md)。

OZDQP 项目在远程分支完整 SHA 核验后可通过事务性 outbox 自动提交本地
Windows CDN 构建；配置、幂等、重试、恢复和审计说明见
[OZDQP CDN 自动构建](./docs/OZDQP-CDN-自动构建.md)。

## 主要目录

- `app/`：现代化管理网页，包括任务、队列、对话、工位、项目和系统设置。
- `server/`：SQLite 持久化、调度状态机、SSE、用户归属记录、Codex 与适配器边界。
- `scripts/hyperv/`：固定参数的 Hyper-V / PowerShell Direct 操作脚本。
- `guest-tools/unity-dialog-guard/`：安装在子机交互桌面的 Unity 弹窗守护程序、规则、自学习和登录自启动脚本。
- `tests/server/`：不触碰真实基础设施的状态机与安全回归测试。
- `.pipeline-data/`：本地 SQLite、附件和 Codex JSONL 日志（已被 Git 忽略）。

## 核心数据模型

- **Task**：长期工作线；固定一个项目、远程分支和 Codex `thread_id`。
- **Turn**：一次需求或微调；它才是排队和调度单位。
- **Worker**：可恢复的 Hyper-V + Unity 工位；不拥有对话历史。
- **Build dispatch**：成功 Turn 同事务写入的异步 CDN 构建意图；Packer
  故障不反向改变 Turn 或 Worker 状态。

因此，释放或更换 Worker 不会丢掉历史。下一轮会从远程任务分支恢复代码，并通过 `codex exec resume <thread_id>` 恢复同一对话。
