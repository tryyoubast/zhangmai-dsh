---
description: "使用受限 PostgreSQL 角色、Redis 和 SMTP 运行需认证的小说创作 HTTP 请求及可恢复生成 Worker。"
kind: "package-reference"
---

# @deepseek-ai/dsh-novel-host

[English](README.md) | 中文

## 概述

使用 PostgreSQL、Redis Streams 和 SMTP 运行小说创作 API 或单个生成 Worker。用户通过 API 登录、排队持久化生成请求并读取已保存结果。Worker 根据每个已持久化任务解析当前权限，通过配置的 Provider 创建草稿。部署方负责受限凭据、数据库结构及 HTTPS 终止。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [当前限制](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

通过包含[小说应用 Bundle](../../bundle/novel-app/README.zh.md) 的自定义 `dsh` Profile 启动本插件。Bundle 提供完整挂载配置；直接挂载必须提供全部 [Config](src/config.ts) 字段。[本地预发布指南](../../../deploy/local-test/README.zh.md)负责基础设施初始化与执行。

### 部署设置

宿主在打开资源前校验设置。默认值由 Bundle 补丁负责，不放在宿主实现中。

| 字段组 | 必填设置 | 职责 |
|---|---|---|
| `mode`, `secretDirectory`, `origin` | `api` 或 `worker`、挂载密钥目录、HTTPS 来源 | 选择进程及浏览器写入策略 |
| `database` | 端点、数据库、四个登录名、连接池大小及超时 | API 模式打开 auth/app/service 连接池；Worker 模式只打开 worker 连接池 |
| `redis`, `smtp` | 端点、Stream/Group、发件人与超时 | 通知已排队任务、限制认证请求及发送认证邮件 |
| `server`, `provider`, `auth` | HTTP 绑定／正文限制、模型端点／限制、令牌／账户设置 | 配置传输、生成及认证 |

宿主读取固定密钥文件名：自身数据库角色的密码、`redis-password`，以及 API 使用的配对 Ed25519 `access-private.pem`/`access-public.pem`。真实 Provider 需要 `deepseek-api-key`；精确的内部夹具 URL `http://model:8081/v1` 始终使用 `fixture-only`，不会读取真实密钥。宿主失败响应不包含密钥文本或驱动错误。

### 可用性与关闭

两种模式均提供 GET `/health/live` 和 `/health/ready`。就绪检查验证受限数据库角色、截至迁移 0022 的必要系统目录能力，包括 Worker 结算函数、以调用者身份执行的发布及候选触发器、八个历史部分索引、六类长文本的 service 读取策略及所需判断函数权限，以及 Redis 和 SMTP，不调用模型。能力或依赖缺失会阻止启动，或返回 `503 {"ready":false}`。关闭期间的健康请求直接返回 503，不启动依赖探测。宿主使用固定诊断信息处理空闲 PostgreSQL 连接池错误，并在关闭连接池后移除监听器。初始化失败会关闭已取得的资源。卸载时先停止队列接收，等待活跃请求和投递结束，再关闭外部客户端及连接池。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

API 在分别受限的连接池上组合现有认证和创作服务。只有成功登录可以初始化工作区成员关系；普通请求解析已有数据库权限，工作区请求头仅作为选择提示。生成任务先提交持久化，再通知 Redis；[HTTP 适配器](../../api/novel-authoring-http/README.zh.md)负责通知失败及重试响应。

Worker 取得 PostgreSQL Session 咨询锁后才恢复 Redis 待处理投递。队列消息只能包含 `workspaceId` 和 `generationRunId` 两个 UUID 字段。每次投递均从 PostgreSQL 解析当前用户／Session／成员权限。Worker 对不存在或处于终态的任务直接确认，不调用模型。同一 Worker 能处理但已失去权限的任务在确认前写入失败终态和审计；权限恢复时保留待处理投递。中断的 `running` 任务变为固定失败状态；排队任务使用领域服务的原子领取。数据库失败保留待处理投递，Provider 失败只有在观察到持久化终态后才确认。锁连接丢失会停止接收并中止 Provider 请求。

| 源码 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 资源取得、HTTP 挂载、Worker 所有权及释放 |
| [runtime.ts](src/runtime.ts) | 受限领域服务组合与系统目录就绪检查 |
| [broker.ts](src/broker.ts), [queue.ts](src/queue.ts) | Redis 协议解析、串行恢复及投递结算 |
| [boundaries.ts](src/boundaries.ts), [config.ts](src/config.ts) | 身份选择、夹具隔离及部署校验 |

本包不发布不变量伴生模块：持久化创作状态和成员关系仍由领域服务掌握；基础设施就绪探针检查外部依赖，不维护独立的领域投影。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [应用 Bundle](../../bundle/novel-app/README.zh.md)：Profile 层及环境设置。
- [认证](../../identity/user-auth/README.zh.md)：账户、Session 与令牌行为。
- [创作服务](../../storage/novel-authoring/README.zh.md)：持久化任务、领取及草稿生成。
- [持久化 Worker 身份](../../../.agents/notes/implemented/architecture/2026-11-11-generation-worker-identity.zh.md)：受限身份查询。

-----

<a id="model-experience"></a>
## 模型体验

### Worker 生成

#### What the model sees

Worker 委托 `DeepSeekNovelGenerationAdapter`；[创作包](../../storage/novel-authoring/README.zh.md#model-experience)负责固定指令及持久化上下文输入。Redis 字段、部署密钥和健康响应不添加模型消息。

#### Token effect

每个新领取的任务最多发起一次 Provider 请求。重复终态投递及中断任务不调用 Provider；输入大小与用量统计由适配器负责。

#### KV Cache effect

宿主不修改消息前缀，也不管理 Provider 缓存；复用行为由适配器和 Provider 决定。

## 当前限制

<a id="known-limitations-and-deferred-work"></a>

- 每个数据库同时仅允许一个 Worker 掌握生成队列；不提供横向 Worker 调度或自动 Provider 重试。
- PostgreSQL 提交与 Redis 通知是独立操作。API 通知失败时需重新提交相同的幂等请求；不提供事务 Outbox。
- 系统目录就绪检查验证最低必要能力，不验证迁移日志哈希。完整结构初始化、HTTPS、凭据轮换和基础设施持久备份由部署方负责。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
