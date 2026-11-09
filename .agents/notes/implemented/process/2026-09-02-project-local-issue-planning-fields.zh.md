# Agent Note: Project 局部 Issue 规划字段

Status: implemented

[English](2026-09-02-project-local-issue-planning-fields.md) | 中文

## 问题

Issue 生命周期工作流需要结构化规划元数据，但组织 Issue 字段使用的 GitHub App 权限独立于组织 Project 权限。具有 Project 写权限的工作流 token 可以读取和更新 Project custom field，而 GitHub 会拒绝读取 Issue 字段，因此同时使用两套存储会让同一策略依赖两组独立管理的权限。

Priority、影响面、解决代价和日期用于在 `DSH Issue Management` 中规划工作。把这些值保存在 Issue 上还会让它们在该 Project 之外可见，但仓库没有需要跨 Project 值的工作流。

## 决策

`DSH Issue Management` Project 使用 Project custom field 存储 `Priority`、`Severity`、`Cost`、`Start Date` 和 `Target Date`。`Severity` 沿用组织字段 `影响面` 的选项含义，`Cost` 沿用 `解决代价` 的选项含义。

可选生命周期从配置的 Project 解析 `Priority` 和 `Start Date`。它拒绝 Issue 字段投影或错误的数据类型，从 Project item 读取 Priority，并通过 `updateProjectV2ItemFieldValue` 写入 Start Date。组织 Issue 字段仅作为带有 `Legacy ...` 前缀的迁移源保留，仓库工作流不会读取它们。

[可移植的 PR 元数据决策](2026-11-09-portable-pr-metadata-and-optional-project.zh.md)将必需的 PR 标签检查与这些规划字段分离，并要求显式启用 Project 自动化。启用后的生命周期读取和 mutation 使用配置的 GitHub App token；必需的 PR 策略既不使用 Project 字段，也不使用 App token。

Issue 生命周期工作流仅在 `pull_request.opened` 时初始化 `Start Date`。工作流读取 PR 的实时正文，保留每个能解析为 Issue 的同仓库引用，把 `created_at` 按配置的 Project 时区转换为日历日期，确保 Issue 是 Project item，并仅在当前 Project 值为空时写入日期。

[组织字段实现](../../archived/process/2026-08-31-pr-opened-issue-start-dates.md)记录了已被取代的跨 Project 所有权决策及其事件时机依据。由事件直接指定的 Status 转换仍由[生命周期决策](2026-08-10-event-directed-pr-review-status.zh.md)负责。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)要求 Priority 和 Start Date 使用 Project custom field，覆盖上海时区日期边界、仅 opened 分派、空值写入、已有值保留和 Project item 缺失，并固定 `updateProjectV2ItemFieldValue`。[工作流测试](../../../../scripts/issue-policy-workflow.spec.ts)固定显式启用以及创建 token 前的仓库验证。删除组织字段前必须逐项比较所有旧字段值与 Project 值，包括已归档的 Project item。

## 考虑过的替代方案

**保留组织 Issue 字段。** 它们可以让一个值在多个 Project 中可见，但工作流不需要该范围，并且 GitHub App 还需要单独的组织 Issue Fields 权限。

**同时写入 Issue 和 Project 字段。** 镜像字段保留跨 Project 可见性，但每个写入方和人工编辑都可能产生偏差，并且还需要协调策略。

**处理每个已订阅 PR 事件或覆盖 Start Date。** 后续事件可以修复缺失日期，但会在工作开始后才赋值或替换人工计划。因此初始化器保留仅 opened、仅空值的行为。

## 后果

规划元数据限定在一个 Project 归属中。同一个 Issue 可以在另一个 Project 中使用不同的值，`DSH Issue Management` 之外的 Issue 没有 Project 局部规划值。

GitHub App 通过 Project 权限而不是组织 Issue Fields 权限访问策略元数据。字段改名或类型变化会让工作流失败，而不会回退到旧字段。

空值读取使通常的重试保持幂等。Project 字段更新没有比较并设置前提，因此同时引用同一个 Issue 的 PR 可能都会观察到空的 Start Date，最后一次 mutation 可能胜出。
