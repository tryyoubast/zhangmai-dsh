# Agent Note: 注册使用原生 UUID 生成

Status: implemented

[English](2026-11-11-registration-user-uuid.md) | 中文

## 问题

注册 ID 必须符合 PostgreSQL 的 UUID 列类型。自定义格式化函数在完整随机字符串中额外插入版本位和变体位，产生无效的 38 字符值，导致注册在发送验证邮件前失败。内存存储不会执行这种数据库类型检查。

## 决策

[认证服务](../../../../packages/identity/user-auth/src/index.ts)使用 Node 的 `randomUUID()` 生成新用户 ID。认证运行角色保存待验证账号时，PostgreSQL 校验该 ID。邮箱验证、密码哈希、会话创建和 refresh family 行为保持既有语义。

## 考虑过的替代方案

**修补自定义格式化函数。** 维护另一套 UUID 实现会增加格式和版本位责任，而 Node 已经提供这些能力。服务中的其他认证标识已经使用原生函数。

**将数据库 ID 改为文本。** 移除类型约束会掩盖格式错误的标识，并要求无关的外键迁移。注册必须满足现有 schema。

## 影响

服务单元测试要求有效的第 4 版 UUID。受限 PostgreSQL 注册测试验证待验证账号、密码哈希、一次性邮箱验证和浏览器会话；HTTPS 验收进一步覆盖已部署的注册和邮件流程。这些检查相互补充，因为存储替身无法拒绝无效的 PostgreSQL 输入。
