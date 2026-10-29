---
description: "面向多用户小说创作的服务端密码与 Token 生命周期基础能力。"
kind: "package-reference"
---

# @deepseek-ai/dsh-user-auth

[English](README.md) | 中文

## 概述

本宿主侧包提供 Argon2id 密码哈希、邮箱规范化、验证／重置生命周期接口、不透明 Session 与 Refresh Token 契约、EdDSA Access Token 基础能力，以及框架无关的 `AuthHttpController`。该控制器覆盖 Web 与官方客户端的认证路由契约，但不是 HTTP 服务器或具体框架路由器。存储和基础设施由调用方注入；原始密码和 Token 不会进入持久化记录。

## HTTP 适配器

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

## 安全约定

使用 `UserAuthService` 时必须提供事务性的 `AuthStore`。不透明 Token 只能保存 `hashToken()` 结果。使用 `RefreshTokenService` 轮换 Refresh Token，并在检测到重用时撤销整个 Token Family。EdDSA 私钥必须放在 Secret Manager，Access Token Claims 不得包含邮箱、密码或其他 PII。

邮箱验证是一个必需的存储操作：底层 Store 必须在原子事务中消费未过期且未使用的令牌，并激活对应用户。

## 模型体验

本包没有模型可见内容。认证决定留在 HTTP／客户端边界，并以服务端解析的身份对象传给领域服务。

## 当前限制

本包不提供以下外围基础设施：

- 完整的 HTTP 服务器／路由器、Redis 客户端、SMTP 客户端、Cookie 中间件、密钥管理服务、PostgreSQL 连接池、迁移、事务／RLS 上下文或运行时凭据管理；

`PostgresAuthStore` 和 `PostgresRefreshTokenStore` 是基于 Drizzle 的轻量 Store 适配器。部署方仍必须提供 Redis 限流、SMTP／邮件投递、工作区身份解析、EdDSA 密钥存储以及外围框架适配器，并使用支持所需 Argon2 原语的 Node 运行时。
