---
description: "通过注入的平台控制器处理 HTTP 认证及工作区隔离的小说创作请求。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-novel-authoring-http

[English](README.md) | 中文

## 概述

宿主可通过同一个 `/api` 适配器提供认证、工作区成员管理、小说草稿、生成、审核、发布、回滚及已保存上下文的访问。宿主负责解析认证身份并注入数据库领域服务。浏览器用户可以排队生成和审核草稿；单独认证的 Worker 执行生成及物化。分发前限制请求正文大小，客户端提交的身份不能建立工作区权限。

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

组合宿主必须先提供 `ctx.webServer` 和 `ctx.platformHttpController`，再挂载这个 Cordis 插件。控制器把认证路由与基于服务端解析的 `AuthPrincipal` 选择的创作服务组合起来；客户端用户 ID、角色或成员关系不能作为授权依据。

### 最小配置

在已提供两个注入服务的组合中挂载这一项：

```yaml
- name: '@deepseek-ai/dsh-api-novel-authoring-http'
  config:
    maxBodyBytes: 65536
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBodyBytes` | 省略 config 参数时为 65536 | 收集请求正文的字节上限，必须是正安全整数；显式传入 config 时必须提供此字段 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-novel-authoring-http)列出接受的配置。超大正文返回 `413 payload_too_large`；无效 JSON 和正文读取错误会在控制器执行前返回 `400 invalid_request`。适配器转发方法、路径名、请求头、解析后的正文及 socket 对端地址，再写回控制器的状态码、响应头和序列化正文。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

`apply()` 通过 WebServer 路由注册器注册 `/api` 前缀及其释放函数，不占用 SPA fallback。`PlatformHttpController` 委托认证，并在解析身份后创建创作服务；`NovelAuthoringHttpController` 使用该身份分发领域操作。

工作区和小说创建、成员邀请／列表／角色变更／撤销、所有权转移及归档／恢复均由已认证的领域服务负责。生成任务创建、仅限 Worker 的生成和提案物化、审核／发布、回滚及持久化上下文读取返回适合 Web UI 的业务状态。浏览器身份可排队生成任务并审核提案，但不能调用仅限 Worker 的生成和提案路由。Cookie/JWT 解析仍由注入的认证服务负责。

[实现代码](src/index.ts)负责分发与响应映射；[Web 适配器测试](tests/web-adapter.spec.ts)验证有界请求处理，[控制器测试](tests/controller.spec.ts)验证基于身份的分发。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [HTTP 子系统](../../../docs/subsystems/web-server.zh.md)：注入控制器与传输层职责。
- [认证库](../../identity/user-auth/README.zh.md)：凭据与身份解析。
- [创作库](../../storage/novel-authoring/README.zh.md)：生成与发布服务。

-----

<a id="model-experience"></a>
## 模型体验

HTTP 分发把生成委托给注入的服务，本包不直接构造模型请求。

#### KV Cache effect

适配器不构造或改写模型输入前缀；生成服务和 Provider 负责缓存行为。

## 当前限制

<a id="known-limitations-and-deferred-work"></a>

- 本包是 HTTP 适配器，不是完整服务器或 Web UI。宿主负责认证／Session 解析、邮件／Redis 控制和浏览器展示。可选生成路由需要注入 `NovelGenerationWorkflowService` 及其 Provider／存储适配器。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
