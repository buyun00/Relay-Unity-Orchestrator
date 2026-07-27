# OZDQP CDN 自动构建

Relay 在一个 Codex Turn 完成 Git push 并核验远程分支 HEAD 后，会异步提交该
Turn 的 OZDQP Windows CDN 构建。构建请求固定使用 Task 的交付分支和刚核验的
完整 40 位 SHA，不使用 Task 的 `baseBranch`，也不等待 Unity 构建完成。

## 可靠性边界

成功交付在同一个 SQLite 事务中完成三件事：

1. 把 Turn 标记为 `success` 并保存交付 SHA；
2. 写入 `turn.delivered`；
3. 写入唯一的 `build_dispatches` outbox 记录及
   `build.dispatch.queued`。

任一写入失败都会回滚整个事务。独立 dispatcher 随后按创建顺序领取 outbox，
向 Packer 提交 HTTP 请求。Packer 离线、超时或返回错误只会改变
`build_dispatches` 的异步状态，不会把已成功的 Relay Turn 改成失败，也不会
阻止 Worker 正常释放。

只有以下条件全部满足才会写 outbox：

- `OZDQP_BUILD_ENABLED=true`；
- 项目启用了“交付后自动构建 Windows CDN”，且项目 Key 是 `ozdqp`；
- 项目仓库 URL 与 `OZDQP_BUILD_REPOSITORY_URL` 一致；
- `delivery.pushed` 与 `delivery.verified` 都是 `true`；
- `delivery.commitSha === delivery.remoteSha`；
- 两个 SHA 都是完整 40 位十六进制；
- `task.branchName` 非空。

升级已有数据库时，迁移只会一次性为仓库 URL 与
`OZDQP_BUILD_REPOSITORY_URL` 完全匹配的既有 OZDQP 项目启用自动构建。之后
可以在“项目”页独立关闭，其他项目默认关闭。

## 配置

私有 Relay 环境文件支持：

```dotenv
OZDQP_BUILD_ENABLED=true
OZDQP_BUILD_API_URL=http://10.100.3.209:8088/api/v1/builds
OZDQP_BUILD_REPOSITORY_URL=http://git.dominogm.com/diaoyu/ozdqp.git
OZDQP_BUILD_API_KEY=
OZDQP_BUILD_TIMEOUT_MS=10000
OZDQP_BUILD_POLL_INTERVAL_MS=1000
OZDQP_BUILD_RETRY_SCHEDULE_MS=1000,2000,5000,10000,30000,60000
OZDQP_BUILD_RETRY_MAX_MS=300000
```

如果 Packer 启用了 API Key 校验，只在私有环境文件中设置
`OZDQP_BUILD_API_KEY`。Token 不会写入 SQLite、事件、日志或错误正文。

项目页还必须启用自动构建并将“构建项目 Key”设为 `ozdqp`。仓库地址应为：

```text
http://git.dominogm.com/diaoyu/ozdqp.git
```

## 请求与幂等

每个 Turn 使用稳定的幂等键：

```text
relay:<turnId>:<commitSha>
```

请求同时声明 `buildType=cdn` 与 `mode=cdn`，核心仓库字段为：

```json
{
  "projectKey": "ozdqp",
  "repository": {
    "url": "http://git.dominogm.com/diaoyu/ozdqp.git",
    "branch": "codex/task-0017-example",
    "commitSha": "0123456789abcdef0123456789abcdef01234567"
  },
  "buildType": "cdn",
  "mode": "cdn",
  "modules": ["all"],
  "playerBaseVersion": 1
}
```

`repository.branch` 始终来自 `task.branchName`。Relay 的 `turn_id` 唯一约束
防止重复写 outbox；Packer 使用相同幂等键及自然构建键去重。即使 Packer 已
接受请求但 Relay 客户端随后超时，重试也仍使用相同键。

## 状态、恢复与审计

outbox 状态流为：

```text
pending -> sending -> accepted
                  \-> retrying -> sending
                  \-> failed
```

- 网络错误、超时、`408/425/429/5xx` 使用退避和抖动重试，并遵守
  `Retry-After`；
- `400/404/409/422` 作为永久契约错误，除非 `409` 响应已包含可复用的
  `job.jobId`；
- `401/403` 作为认证配置错误停止快速重试；
- 服务启动时把遗留的 `sending` 恢复为 `retrying`，继续使用原幂等键；
- 同一分支的多个 Turn 按 Turn 顺序领取。

可通过以下只读接口查看最近状态：

```http
GET /api/build-dispatches
GET /api/build-dispatches?status=retrying&limit=100
```

SQLite 保存尝试次数、下次重试时间、HTTP 状态、脱敏错误分类、Packer Job ID
及时间戳。事件流记录：

- `build.dispatch.queued`
- `build.dispatch.retrying`
- `build.dispatch.accepted`
- `build.dispatch.failed`

事件和 outbox 都不会保存 Packer 的完整错误正文或 API Key。
