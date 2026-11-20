# Agent Note: 隔离的小说创作 staging profile

Status: implemented

[English](2026-11-11-local-novel-staging.md) | 中文

## 问题

认证、创作、生成和发布服务需要组装成 HTTP 应用，才能验证组合行为。单元测试无法独立覆盖安全浏览器 Cookie、邮件投递、受限运行数据库角色、持久化队列恢复或进程重启后的已保存上下文。

## 决策

[小说应用组合包](../../../../packages/bundle/novel-app/README.zh.md)为独立、仅启动加载的 `novel-api` 和 `novel-worker` profile 提供一个宿主条目，二者均通过现有 `dsh` 启动器启动。[宿主](../../../../packages/host/novel-host/README.zh.md)组合现有领域服务，不引入另一套认证或生成实现。API 连接池分别使用 auth、app、service 角色；worker 仅使用 worker 角色。[本机部署](../../../../deploy/local-test/README.zh.md)负责独立 Compose 基础设施、固定镜像、本地凭据，以及由 HTTPS 客户端显式信任的 CA。

Node 不提供可选 Loader 内部机制时，vendor 回退从自身目录导入，丢失 profile 的依赖位置。app-boot Include 适配层使用 `import-meta-resolve` 和公开 ESM import，从配置或显式宿主 base URL 解析。profile 依赖保持优先，并支持仅供 import 使用的导出；无需全局包链接或修改 vendor。回退选择 `node`/`import` 导出条件，因此自定义条件仍是已记录的限制。

PostgreSQL 保存完整生成请求与结果；Redis 仅携带 workspace/run UUID。持久化先于通知；通知失败返回 503，原请求与幂等键可重试通知而不新增任务。在保留当前 schema 的同时，跨系统失败被明确呈现。

数据库级 session advisory lock 仅允许一个活跃 worker。串行消费者先恢复待处理消息，再读取新消息；每次投递重新核对持久化权限，并使用已有的原子任务领取。终态投递直接确认；中断的 running 任务标为失败，不再次调用供应商。所有权连接丢失时停止读取并取消供应商请求。卸载先等待所属请求与投递结束，再关闭外部资源。

固定模型无需供应商密钥。每次普通 Compose 操作均显式选择内部端点；只有真实验收会在独立、排他创建的两任务预算内覆盖端点，完成或失败后恢复固定端点。持有模型响应的探针即使提交或观察失败，也会重启 worker。只追加审计与持久测试卷均保留，普通关闭不会销毁它们。

## 考虑过的替代方案

**启动独立服务可执行文件。** 新入口绕过 profile 组合与生命周期归属。宿主保持为现有启动器挂载的 Cordis 插件。

**在 Redis 消息中保存指令或身份。** 重复数据可能偏离已存请求，并允许队列字段冒充权限。仅携带定位信息，让持久化与当前身份校验留在 PostgreSQL。

**自动重试中断的模型调用。** 断开的 worker 无法证明供应商未计费或完成第一次请求。将任务标为失败，使下一次付费生成成为用户以新键明确发起的操作。

**增加事务 outbox。** 它需要超出已批准本机集成范围的额外持久 schema 与调度器。API 改为报告通知失败并保留客户端幂等恢复；无人值守恢复仍是限制。

## 影响

每个数据库同一时间只执行一个 worker；不承诺水平调度或供应商计费恰好一次。运行 profile 不持有迁移或管理员凭据。就绪检查验证必需 catalog 能力，不向运行角色授予私有迁移日志访问权；部署通过受控迁移器保留完整校验和验证。

验收脚本通过 HTTPS 断言业务效果，以只读数据库核对和受限 worker 拒绝探针补充证据；同时独立运行已有 refresh family 并发套件和新增 worker/workspace PostgreSQL 套件。结果与镜像身份属于忽略的环境证据；源码中的 CI 必须执行无密钥 Compose 流程，不声称覆盖真实供应商。

准备过程分别检测迁移 0001 与其 ownership 日志，两个提交步骤之间中断后仍可继续。已有登录会再次获得精确的运行角色授权。独立、可丢弃的 PostgreSQL 容器验证这两种中断状态，不替换已保留的验收数据库。
