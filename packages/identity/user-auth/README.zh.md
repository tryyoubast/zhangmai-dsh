---
description: "面向多用户小说创作的服务端密码与 Token 生命周期基础能力。"
kind: "package-library"
---

# @deepseek-ai/dsh-user-auth

[English](README.md) | 中文

## 概述

本宿主侧包提供 Argon2id 密码哈希、邮箱规范化、验证／重置生命周期接口、不透明 Session 与 Refresh Token 契约、EdDSA Access Token 基础能力，以及框架无关的 `AuthHttpController`。该控制器覆盖 Web 与官方客户端的认证路由契约，但不是 HTTP 服务器或具体框架路由器。存储和基础设施由调用方注入；原始密码和 Token 不会进入持久化记录。

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

宿主导入服务与 Store，并把控制器接到自己的 HTTP 适配器；本库没有独立的插件挂载项。

### HTTP 适配器

`AuthHttpController.handle()` 分发以下路由：

- `POST /api/auth/register`
- `POST /api/auth/verify-email`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/refresh`
- `POST /api/auth/forgot-password`
- `POST /api/auth/reset-password`
- `GET /api/auth/me`

浏览器登录返回带有 `HttpOnly`、`Secure`、`SameSite=Lax` 和 `Path=/` 的 `__Host-dsh_session` Cookie。官方客户端登录和刷新返回短期 EdDSA Access Token 以及轮换后的不透明 Refresh Token。状态变更请求可以校验允许的 `Origin`；宿主应用仍需把控制器接入自身 HTTP 框架、Session 解析器、工作区身份解析器和密钥管理系统。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

### 安全约定

使用 `UserAuthService` 时必须提供事务性的 `AuthStore`。不透明 Token 只能保存 `hashToken()` 结果。使用 `RefreshTokenService` 轮换 Refresh Token，并在检测到重用时撤销整个 Token Family。EdDSA 私钥必须放在 Secret Manager，Access Token Claims 不得包含邮箱、密码或其他 PII。

邮箱验证是一个必需的存储操作：底层 Store 必须在原子事务中消费未过期且未使用的令牌，并激活对应用户。

Refresh token 轮换由 Store 的单个事务负责，包括重放检测、family 撤销和仅追加安全审计。PostgreSQL 存储按用户、family、token 顺序加锁，并在取得 family 锁后重新读取 token。首次签发和显式撤销遵循同一协议；密码重置先独占锁定用户，再枚举其 family。并发重用会撤销所有后代，其他 family 保持不变。未知、过期、撤销和重用凭证均返回 `401 invalid_refresh_token`；审计或数据库失败会回滚，并返回既有可用性错误。[事务锁决策](../../../.agents/notes/implemented/bug-fix/2026-11-09-refresh-family-transaction-locks.zh.md)说明锁模式及替代方案。

`pnpm run test:postgres` 执行独立的 PostgreSQL 18 回归测试。它要求认证运行账号使用 `DATABASE_TEST_URL`，迁移账号使用 `DATABASE_MIGRATION_URL`，且两者指向同一个名称包含 `test` 的隔离数据库。配置缺失或不一致时直接失败，不跳过；测试从不加载生产 `.env`。fixture 要求已应用提交的迁移和 ownership bootstrap，宿主必须销毁测试数据库，才能移除仅追加审计记录。

`AuthHttpController.handle()` 在错误处理范围内等待路由操作。符合现有分类的凭据校验错误返回 `400 invalid_request`；其他失败返回 `500 authentication_unavailable`，不包含原始错误详情。会话解析器可以依赖实例状态：控制器通过解析器对象调用其方法。JWT 解析先校验解码对象及字段，再返回声明。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [认证子系统](../../../docs/subsystems/identity-auth.zh.md)：Refresh Token 持久化类型和事务语义。
- [HTTP 子系统](../../../docs/subsystems/web-server.zh.md)：请求与响应适配。
- [PostgreSQL 库](../../database/database-postgres/README.zh.md)：连接池和凭据职责。

-----

<a id="model-experience"></a>
## 模型体验

本包不构造模型请求；认证操作解析服务端身份，再把身份交给领域服务。

#### KV Cache effect

认证不改写模型输入前缀；消费身份的服务负责后续模型请求及缓存行为。

## 当前限制

<a id="known-limitations-and-deferred-work"></a>

- 本包不提供完整 HTTP 服务器／路由器、Redis 客户端、SMTP 客户端、Cookie 中间件或密钥管理服务。`PostgresAuthStore` 和 `PostgresRefreshTokenStore` 是基于 Drizzle 的轻量 Store 适配器，但调用方负责 PostgreSQL 连接池、迁移、事务／RLS 上下文和运行时凭据。部署方必须提供 Redis 限流、SMTP／邮件投递、工作区身份解析、EdDSA 密钥存储及外围框架适配器，并使用支持所需 Argon2 原语的 Node 运行时。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
