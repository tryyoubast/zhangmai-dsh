# PR 元数据与可选 Issue Project 自动化

[English](README.md) | 中文

本文参考定义必需的 PR 元数据检查与显式启用的 Issue Project 工作流。预览发布有独立的[配置说明](../preview-sizing/README.zh.md#publication-semantics)。

## 必需的 PR 元数据

必需检查仍名为 `Issue policy`。人工用户提交的非草稿 PR 在存在请求评审人或任何已提交评审后进入强制范围；草稿、Bot/App 作者以及尚未进入评审的 PR 豁免。检查要求恰好一个允许的 `kind/*` 和至少一个 `area/*`；[标签分类体系](../../.agents/notes/implemented/process/2026-08-08-unified-github-label-taxonomy.zh.md)定义变更类型、可扩展领域与保留别名。`source/*` 仅用于 Issue。优先级可选：使用零个或一个小写 `p0`、`p1`、`p2` 或 `p3`；大写别名会被拒绝。

PR 正文中的 Issue 引用可选。检查仅通过触发仓库的只读 `GITHUB_TOKEN` 读取实时 PR 标签、请求评审人和已提交评审；`GITHUB_REPOSITORY` 标识该仓库。检查不读取 PR 正文、Issue、Project 或可选 Project 配置。普通 `pull_request` 作业检出当前事件 SHA，并禁用凭据持久化；受信任的评审写入工作流保留自身的执行策略。

<a id="optional-issue-project-integration"></a>

## 可选的 Issue Project 集成

[Issue 生命周期](../workflows/issue-lifecycle.yml)默认关闭，只有仓库变量 `DSH_ISSUE_PROJECT_ENABLED` 精确为 `true` 时才启用。关闭时不创建 App token，也不调用 Issue 或 Project API。启用时，须在 [config.json](config.json) 中配置触发仓库与目标组织 Project，并为具有所需仓库 Issue 和组织 Project 权限的 App 设置变量 `DSH_ISSUE_APP_CLIENT_ID` 与 secret `DSH_ISSUE_APP_PRIVATE_KEY`。配置预检会在创建 token 前拒绝仓库不匹配的情况。

启用后检出受信任的默认分支代码，排除 Bot/App 发送者和 PR 作者，并保留已订阅的 Issue 与 PR 生命周期事件。只有已提交的 `changes_requested` 评审能够创建生命周期 token；approved/commented 评审成功结束且不修改看板。可选工作流负责 Issue 标签修复与审计、[由事件直接指定的状态转换](../../.agents/notes/implemented/process/2026-08-10-event-directed-pr-review-status.zh.md)以及 [Project 局部规划字段](../../.agents/notes/implemented/process/2026-09-02-project-local-issue-planning-fields.zh.md)。它独立于必需的 PR 检查，且绝不创建 Issue。

## 验证

运行 `pnpm run test:issue-management` 检查纯元数据、只读 API 和可选生命周期的回归。运行 `pnpm exec vitest run scripts/issue-policy-workflow.spec.ts scripts/preview-workflow.spec.ts` 检查工作流权限、事件与代码选择，以及显式启用后的凭据处理。[决策记录](../../.agents/notes/implemented/process/2026-11-09-portable-pr-metadata-and-optional-project.zh.md)说明了拆分原因。
