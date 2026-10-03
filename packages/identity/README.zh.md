---
description: "identity 包组：由遥测、反馈与 DeepSeek 提供方请求共享的匿名关联 id，每个 harness home 一个。"
kind: "package-group"
---

# identity/ — 共享身份

[English](README.md) | 中文

## 概述

identity 组提供匿名安装关联和多用户认证基础能力。认证包只面向服务端，负责密码与 Token 生命周期接口；不会向调用方暴露数据库凭据或原始 Token 持久化。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

<a id="packages"></a>
## 包

| 包 | 职责 |
|---|---|
| [`anonymous-user-id`](anonymous-user-id/README.zh.md) | 让每个 harness home 拥有一个匿名 id，遥测、反馈与 DeepSeek 请求把它附加到记录上，使来自同一安装的记录无需识别用户即可被辨认 |
| [`user-auth`](user-auth/README.zh.md) | 提供 Argon2id 密码哈希、邮箱验证／重置生命周期接口、不透明 Session／Refresh Token 与 EdDSA Access Token 基础能力 |

<a id="related-documentation"></a>
## 相关文档

- [会话遥测子系统](../../docs/subsystems/session-telemetry.zh.md)——在导出中携带该 id 的遥测功能。
- [dsh-llm-deepseek](../llm/llm-deepseek/README.zh.md)——在请求中携带该 id 的 DeepSeek 提供方。
- [dsh-command-feedback](../feedback/command-feedback/README.zh.md)——在确认文本中点名该匿名安装的反馈命令。

<a id="dev-note"></a>
## 开发备注

无。
