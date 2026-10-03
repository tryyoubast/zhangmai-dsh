---
description: "面向生产应用数据和迁移的数据库基础设施包。"
kind: "package-group"
---

# packages/database

[English](README.md) | 中文

## 概述

数据库组负责生产数据库连接和迁移基础设施，与通用 SQLite 存储枢纽保持独立。这些包只面向宿主侧；缺少部署所需配置时必须明确失败。

## 包

| 包 | 职责 |
|---|---|
| [`database-postgres`](database-postgres/README.zh.md) | PostgreSQL 连接池、Drizzle Schema、迁移 SQL、角色、授权和 RLS 基础 |

## 开发备注

认证流程、密码哈希、Redis 协调、邮件发送和小说创作服务通过独立包消费本组提供的 PostgreSQL 基础设施。
