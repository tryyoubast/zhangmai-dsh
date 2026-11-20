---
description: "通过 Docker Compose 运行隔离的本机 PostgreSQL、Redis、邮箱、HTTPS API 和生成 worker 验收。"
---

# 本机小说创作验收

[English](README.md) | 中文

## 摘要

启动空白且隔离的测试应用，通过 HTTPS 验证注册、验证后登录、草稿生成、审核、发布、回滚和重启恢复。固定模型无需供应商密钥；独立命令最多允许两个真实 DeepSeek 生成任务。关闭环境后，测试数据与审计历史仍然保留。

## 目录

- [前置条件](#prerequisites)
- [启动并验证](#start-and-verify)
- [真实供应商验收](#real-provider-acceptance)
- [停止并保留数据](#stop-and-preserve-data)
- [隔离与责任归属](#isolation-and-ownership)
- [证据与排错](#evidence-and-troubleshooting)
- [开发备注](#dev-note)

<a id="prerequisites"></a>
## 前置条件

使用 Node 24、pnpm 11.7.0，以及具备运行中 Linux 引擎和 Compose 的 Docker Desktop。先运行 `pnpm install --frozen-lockfile`，再从仓库根目录执行命令。Windows 管理命令会自动定位 Docker Desktop 标准安装路径下的 CLI。本机回环地址上的 8443 和 8025 端口必须可用。

[images.lock.env](images.lock.env) 固定已审查的镜像摘要。Docker Library 镜像使用官方 AWS Public ECR 分发地址；Mailpit 使用发布者的 GHCR 分发地址。应用镜像以当前工作区、固定 Node 镜像和冻结的工作区依赖构建。

<a id="start-and-verify"></a>
## 启动并验证

```sh
pnpm run staging:init
pnpm run staging:up
pnpm run staging:test
```

初始化在忽略的 `.local/` 中创建凭据、Ed25519 密钥对和独立的 `novel-api`/`novel-worker` profile。重复初始化保留已有材料，并拒绝不匹配的密钥对。启动先构建应用，在仅准备 `dsh_staging_test` 和 `dsh_refresh_test` 前停止 API 与 worker，再通过 `dsh --profile` 先启动 API、后启动 worker，使冷启动的共享模块准备串行完成，并将 Caddy 本地 CA 复制至 `.local/local-ca.crt`。首次 ownership 准备或运行角色授权中断时，下次启动会继续完成。升级前保留数据库备份；迁移失败时两个消费者保持停止，所有卷均保留。

业务入口为 `https://localhost:8443`；Mailpit 为 `http://127.0.0.1:8025`。验收客户端显式信任导出的 CA，并维护真实 Cookie jar；不会关闭证书检查或修改系统信任。测试邮件包含一次性验证／重置 token；邮箱应始终仅在本机开放。

模拟流程显式选择内部模型，不受继承的供应商设置影响。它验证十四种草稿目标类型、workspace 隔离、归档工作区恢复、人工审核、发布与回滚、幂等、非法模型输出、部分物化、待处理消息恢复、任务中断失败和 Redis 通知恢复，也运行独立的受限 PostgreSQL 测试，并在独立、可丢弃的容器中验证准备中断恢复。升级工具创建唯一名称、停留在 0019 的隔离测试库，使用受限凭据检查前向迁移及来源冲突，并保留数据与审计；只有初始准备使用管理员。逐项 PASS 输出及 `.local/evidence/mock-acceptance.json` 记录实际进度；命令失败不表示验收完成。

仅运行受限 PostgreSQL 测试时使用：

```sh
pnpm run staging:test:postgres
```

<a id="real-provider-acceptance"></a>
## 真实供应商验收

将 API key 直接写入 `.local/secrets/deepseek-api-key`；不要粘贴到命令、聊天或已提交文件中。先完成模拟验收，再检查凭据：

```sh
pnpm run staging:check:provider
```

隔离工具使用与 worker 相同的 Compose 网络和供应商密钥，不接收数据库凭据，也不挂载应用 home。脚本以只读绑定挂载，因此无需重建镜像。工具只请求 `https://api.deepseek.com/v1/models`，要求 HTTP 200，且模型目录包含配置的 `DSH_NOVEL_PROVIDER_MODEL`，默认值为 `deepseek-chat`。密钥缺失或为空、HTTP 401、传输失败、15 秒超时、JSON／目录无效和模型不存在均以非零状态退出。诊断仅含固定结果标签、HTTP 状态、模型是否存在，以及宿主机解析后的密钥文件路径和修改时间；不含密钥、响应正文或异常细节。该命令不提交生成任务，也不改变付费任务预算。

仅当 `.local/evidence/real-provider-budget.json` 不存在时开始新一轮验收：

```sh
pnpm run staging:test:real
```

每轮最多允许两个真实生成任务。预算已存在时，普通调用会拒绝运行，并保留原 `real-acceptance.json`。要使用剩余的一次任务，已有预算必须恰好为 `submitted: 1`、`maximum: 2`：

```sh
pnpm run staging:test:real -- --resume
```

恢复流程在 HTTPS、模拟验收证据和凭据检查、固定模型准备、付费请求、重启及 worker 恢复期间，始终持有排他的 `.local/evidence/real-provider-budget.lock`。模拟验收及 `up`、`restart`、`down`、`reset` 使用同一把锁，防止并发改变端点。已有锁或遗留锁都会拒绝运行，程序不会自动删除；手动恢复前应核查锁记录的持有者。凭据预检失败（包括 HTTP 401）不创建业务数据，也不改变预算。

预检通过后，恢复流程创建新用户和小说，使用固定模型准备全部十四种目标类型，并在重启后检查数据。在切换供应商或预留预算之前，worker 使用完全相同的续写指令及 `limit: 8` 执行生产检索和排序。该只读检查核验准备任务的身份和小说归属，返回来源标识、排名和哈希；上下文为空则失败。随后在提交前原子记录 `submitted: 2`，恰好提交一次真实请求，生成人物、地点和章节草稿（`chapterNo: 2`），供应商调用限制为一次，且不启用 enrichment 或自动重试。提交失败、额度不足、网络失败或进程中断均不退还这次预留。第二次重启检查已保存的草稿结果及所选上下文标识、排名和哈希，不再发起真实请求。

模拟验收在独立的固定模型小说中执行这条完整指令，验证第 2 章、历史来源归属及重启后的精确上下文，不改变付费预算。任务 completed 不等于持久化验收通过：恢复失败报告包含 `failureStage`、已知任务定位和失败场景。[检索决策](../../.agents/notes/implemented/bug-fix/2026-11-13-context-retrieval-fallback.zh.md)说明严格匹配及任一词回退语义。

恢复流程独立写入 `real-acceptance-resume-<UUID>.json`，并保留原报告。持有锁的各阶段无论成功或失败，均在释放锁前恢复并核验固定模型 worker。内部端点始终使用固定的非秘密凭据，即使真实密钥已经存在。请将预算与报告一起保留；改变或补充付费预算需要新的明确验收决定。[决策记录](../../.agents/notes/implemented/bug-fix/2026-11-13-bounded-real-provider-resume.zh.md)说明保守的失败处理规则。无密钥测试与凭据预检通过不能证明两次真实生成成功；本机操作者必须检查实际验收报告。

<a id="supplemental-real-acceptance"></a>
### 追加真实验收

本次追加验收使用原状态目录 `E:/Codex/staging-acceptance/local-state`、已耗尽的历史账本和 `deepseek-flash` 模型。先构建镜像，在当前 API 和 worker 镜像上通过完整固定模型验收，再检查模型目录并启动追加验收：

```powershell
$env:DSH_NOVEL_PROVIDER_MODEL = 'deepseek-flash'
pnpm run staging:check:provider -- --state-dir E:/Codex/staging-acceptance/local-state
pnpm run staging:test:real -- --supplement --state-dir E:/Codex/staging-acceptance/local-state
```

独立的 `real-provider-budget-supplement.json` 最多预留两次任务，原账本保持不变。次数限制统计提交数，不是金额上限。第一次在全新小说中生成三种草稿。第二次预留前，脚本核验第一章及草稿重启后未变，并用完整续写指令验证只召回第一次任务的上下文。第二次任务必须落库新草稿和与预检一致的上下文，包含来源标识、排名、哈希。再次重启后比较已保存快照，最后恢复固定模型 worker。启用真实端点期间不要让其他客户端使用本地测试 API。

如果第一次任务已有通过验证的检查点，且尚未预留第二次，先查看失败阶段，再执行下列命令。脚本从 Windows DPAPI 保护的本地 secret 读取登录材料，以同一个测试用户重新登录，并重新核验原草稿和上下文。若先前进程留下锁，手动处理前须确认持锁进程已退出、worker 已停止处理该任务。检查点缺失或无效、首次提交结果不明、续写已经预留时，禁止再次提交。追加验收不退款、不重复提交。

```powershell
pnpm run staging:test:real -- --supplement --resume --state-dir E:/Codex/staging-acceptance/local-state
```

新报告独立保存，不覆盖历史尝试记录。账本是预留次数的依据，报告记录验收和恢复结果。[决策记录](../../.agents/notes/implemented/bug-fix/2026-11-18-real-provider-supplement.zh.md)说明检查点与预算规则。

<a id="stop-and-preserve-data"></a>
## 停止并保留数据

```sh
pnpm run staging:down
```

关闭移除本项目容器与网络，保留命名卷、凭据、profile 和证据。再次启动检查迁移历史并复用已有应用数据。销毁需要独立的显式操作 `pnpm run staging:reset -- --confirm=dsh-local-test`，仅删除项目的数据卷；它不属于验收或普通关闭流程。

<a id="isolation-and-ownership"></a>
## 隔离与责任归属

只有 HTTPS 和邮箱管理 UI 发布回环端口。PostgreSQL、Redis、SMTP、固定模型与 worker 均留在 Compose 网络内。项目名称为 `dsh-local-test`，其数据卷不导入现有本地业务数据。

一次性准备容器只用临时管理员执行迁移 0001 和 ownership bootstrap，后续迁移使用受限迁移器。API 连接池分别使用 auth、app、service 角色；worker 连接池仅使用 worker 角色。运行 profile 不接收管理员或迁移凭据。核对工具单独持有迁移凭据，开启只读事务；worker 拒绝探针仅使用 worker 凭据，并回滚每次写入尝试。

业务库和 refresh token 回归库使用独立的运行与迁移登录。回归要求数据库名称含 test，且不加载生产 `.env` 文件。其工具容器保持应用镜像只读，仅在内存中挂载临时 Vite 缓存。审计行保持只追加。[数据库归属](../../packages/database/database-postgres/README.zh.md)及 [worker 身份](../../packages/storage/novel-authoring/README.zh.md)分别说明 SQL 与 RLS 细节。

[宿主](../../packages/host/novel-host/README.zh.md)负责关闭连接、请求权限、队列读取和 SMTP 传输。队列仅携带 workspace/run 定位信息；PostgreSQL 提供当前用户、session 与成员权限。通知失败时在持久化后返回 503，客户端应使用相同请求与幂等键重试。中断的 running 任务转为 failed，需要新键才能明确发起新的生成。

<a id="evidence-and-troubleshooting"></a>
## 证据与排错

`.local/evidence/` 保存镜像身份与场景结果，不保存注入的密钥、邮件正文、Authorization header 或完整供应商响应。必需 CI job 上传该目录，并始终关闭 Compose 项目。真实供应商验收在本地独立进行，不计作无密钥 CI 证据。

`GET /health/live` 检查进程存活。`GET /health/ready` 检查受限数据库角色与最低 schema 能力、Redis 和 SMTP，不调用模型，也不读取私有迁移日志；迁移校验和由准备容器负责。使用 Compose 服务状态和脱敏日志区分镜像、网络、启动问题与业务断言失败。不能用单元测试或原生数据库结果替代失败的 Compose 验收。

<a id="dev-note"></a>
## 开发备注

本地 CA 与凭据是可丢弃的环境材料。本环境用于验收；生产 DNS、密钥管理、备份、扩容、监控和恢复目标需要另行制定部署决策。
