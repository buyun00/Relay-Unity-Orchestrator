# Unity Dialog Guard

Unity Dialog Guard 是 Relay 子机内部的独立桌面守护程序。它只在子机的
Unity 自动登录账户中运行。已知规则的发现和点击不依赖宿主机；
PowerShell Direct 只用于可选的 AI 未知窗口决策接口。

## 行为

- 每 400 ms 扫描由 `Unity.exe` 创建的候选弹窗。先排除普通 Editor 主窗口，
  再以最大深度和节点数限制逐层读取 UI Automation 子树，避免 Unity
  可访问性树递归导致栈溢出或假活。
- 1.1.7 使用原生顶层窗口枚举后先按 Unity 进程、owner 与窗口类过滤，再读取标题
  或对候选窗口接入
  UIA；标准 `#32770` 弹窗全程使用原生控件，不再被卡住的 Unity UIA provider
  阻塞。它也不再扫描整个桌面，从而避免被
  无关或卡住的 UIA provider 拖死，并避免遗漏 owned 模态窗口。已尝试点击但仍然
  可见的弹窗继续出现在 pendingDialogs，不将“点击过”当作“已解决”。
- 生产 Unity 进程的扫描与交互学习使用原生窗口/输入钩子，不注册全桌面 UIA
  子树；UIA学习路径只在独立回归fixture中启用。系统UIA provider卡住时，原生
  扫描、心跳及业务解阻仍继续，学习能力不再成为主流程门禁。
- 控制状态原子替换遇到短暂读锁时做有界重试，避免健康进程长期留下旧心跳。
- 首批 `config.json` 规则会自动处理：
  - 场景被外部修改：选择 `Ignore` 保留内存；原任务另行保全脏场景后再决定加载磁盘；
  - 外部修改的 UI Document、资源或脚本：选择 `Reload` / `Recompile`；
  - API Updater 同意窗口：选择备份确认、`Update` 或 `Yes`；
  - `Enter Safe Mode?`：默认选择 `Ignore`；
  - 兼容的项目版本升级提示：选择 `Continue` / `Open`。
- 点击优先使用 Windows UI Automation `InvokePattern`，无法使用时才对
  原生按钮发送 `BM_CLICK`；不使用屏幕坐标。
- 未匹配的模态窗口会立即写入 `logs\unknown-dialogs.jsonl`，并尽量保存
  局部截图。
- `autoLearn=true` 时，用户第一次在未知弹窗中点击按钮，守护程序会记录
  弹窗的规范化指纹和按钮名称到 `learned-rules.json`。同类弹窗再次出现
  时自动执行同一按钮。
- 守护程序持续写入 `control\state.json` 心跳和待处理窗口；AI 只能从其中
  已枚举的按钮选择动作，不能提交任意坐标或任意命令。删除、覆盖、丢弃、
  重置等高风险动作默认拒绝，必须携带显式高风险授权。

`learned-rules.json` 是完整、独立、可复制的同步文件。复制前停止目标机上
的守护进程，覆盖目标文件，再启动计划任务即可。路径、GUID、版本号以及
常见 Unity 资源文件名会在指纹中规范化，因此同一类弹窗包含不同项目路径
或文件编号时仍可复用。

## 构建

### 检查点恢复后的版本同步

宿主 `.pipeline-data/unity-dialog-guard` 可放置经过完整交互回归的
`UnityDialogGuard.exe` 与 `manifest.json`（schemaVersion=1、validated=true、
version、sha256、additiveRule）。只能发布已验证的精确二进制，不在恢复时构建。
`Restore-Worker.ps1` 在来宾就绪后调用 `Sync-UnityDialogGuard.ps1`：版本无变化时
不重启；更新时只重启 Guard，保留自定义配置、禁用规则、学习规则、日志及独占
回滚备份，核验新进程心跳。失败回滚并告警，不阻塞后续业务；未安装则跳过。

在 Windows PowerShell 5.1 中运行：

```powershell
.\Build-UnityDialogGuard.ps1
```

脚本使用 Windows 自带的 .NET Framework 4.x C# 编译器，生成
`bin\UnityDialogGuard.exe`，不要求安装 .NET SDK。

## 安装和自启动

必须在子机的 Unity 自动登录账户中打开“管理员 PowerShell”，然后运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\Install-UnityDialogGuard.ps1
```

安装器执行以下操作：

1. 构建程序并复制到 `C:\ProgramData\Relay\UnityDialogGuard`；
2. 首次安装时复制 `config.json` 和空的 `learned-rules.json`；
3. 注册 `\Relay\UnityDialogGuard` 登录触发计划任务；
4. 使用 `Interactive` 登录类型和当前登录用户，确保能看到 Unity 桌面；
5. 立即启动并返回任务状态和进程 ID。
6. 配置任务异常退出后每分钟自动重启，并保留上一版可执行文件
   `UnityDialogGuard.exe.previous`。

重复安装会保留实际 `config.json`、`learned-rules.json` 和日志，同时将仓库
最新默认规则写到 `config.defaults.json`。需要强制换成仓库默认配置时：

```powershell
.\Install-UnityDialogGuard.ps1 -ReplaceConfig
```

制作 `PROJECT_READY` 检查点前，应确认计划任务为 `Running`，并确保守护
程序进程已经在 Unity 所在的用户会话中。

## 配置和学习文件

- `config.json`：手工维护的默认规则和运行参数。
- `learned-rules.json`：用户首次处理未知弹窗后自动生成的规则。
- `logs\actions.jsonl`：启动、自动点击、学习和失败记录。
- `logs\unknown-dialogs.jsonl`：未知弹窗的标题、正文、按钮和指纹。
- `logs\screenshots\`：能够从交互桌面捕获时保存的未知窗口截图。
- `logs\errors.log`：守护程序内部错误。
- `control\state.json`：进程、会话、最后扫描时间和当前未知弹窗。
- `control\requests` / `control\responses`：受限 AI 动作请求与结果。

已知规则按文件顺序匹配。每条规则必须同时满足其中填写的
`titleRegex`、`textRegex` 和 `buttonRegex`，然后按 `targetButtonNames`
顺序选择按钮。规则默认每个弹窗实例只尝试一次，防止错误窗口形成点击
循环。

## AI 未知窗口接口

Relay/Codex 先读取状态，可选把当前未知弹窗截图导出到宿主机：

```powershell
.\scripts\hyperv\Get-UnityDialogGuardState.ps1 `
  -VMName lin-worker-01 `
  -CredentialPath C:\ProgramData\Relay\secrets\lin-worker-01.xml `
  -ScreenshotDirectory C:\ProgramData\Relay\data\dialog-snapshots
```

确认标题、正文、截图和按钮后，只能使用状态中返回的 `dialogId` 与
`buttonId`：

```powershell
.\scripts\hyperv\Invoke-UnityDialogGuardAction.ps1 `
  -VMName lin-worker-01 `
  -CredentialPath C:\ProgramData\Relay\secrets\lin-worker-01.xml `
  -DialogId '<state dialogId>' `
  -ButtonId '<state buttonId>' `
  -Rationale 'Reload externally modified project files'
```

接口会拒绝已经消失的窗口、未枚举按钮和未显式授权的高风险动作。每次
AI 操作都会写入 `logs\actions.jsonl`，包含操作者、理由、风险等级和结果。

Unity 官方说明 Safe Mode 不运行项目或包中的托管代码。为保证子机的
Unity Skill 仍有机会加载，默认规则选择 `Ignore`。如果某个项目的 Skill
不依赖项目托管代码，并且团队更重视安全导入，可把该规则目标改为
`Enter Safe Mode`。

首批规则依据 Unity 官方资料整理：

- [Safe Mode](https://docs.unity3d.com/cn/current/Manual/SafeMode.html)
- [Unity Editor 命令行参数与 API Updater](https://docs.unity3d.com/cn/current/Manual/EditorCommandLineArguments.html)
- [UI Document 外部修改弹窗 UUM-107642](https://issuetracker.unity3d.com/issues/ui-document-was-modified-externally-pop-up-appears-when-reimporting-assets)
- [API Update Required 按钮文本](https://issuetracker.unity3d.com/issues/unity-obsolete-api-updater-leaves-a-semicolon-when-removing-mesh-dot-optimize-method-out-of-the-scripts)

## 验证

集成测试会打开真实 WPF 模态窗口，验证已知规则自动点击、未知窗口
状态输出、受限 AI 按钮操作、第一次人工操作学习、规则落盘，以及下一次
自动点击：

```powershell
.\Test-UnityDialogGuard.ps1
```

## 卸载

默认删除计划任务和可执行文件，保留配置、学习文件及日志：

```powershell
.\Uninstall-UnityDialogGuard.ps1
```

需要同时删除全部数据时显式执行：

```powershell
.\Uninstall-UnityDialogGuard.ps1 -RemoveData
```
