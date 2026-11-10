# Agent Note: 可移植的 PR 元数据与可选 Project 自动化

Status: implemented

[English](2026-11-09-portable-pr-metadata-and-optional-project.md) | 中文

## 问题

必需的标签检查若读取组织 Project 的规划字段，就需要独立安装的 GitHub App 和已配置的看板。这种依赖会阻止本应独立运行的仓库或 fork 验证进入评审的 PR，并将评审分类与 PR 外部的规划数据耦合。

Issue 状态投影与规划日期仍对主动运营该 Project 的仓库有用。其写入权限需要受信任的代码与显式目标，并独立于 PR 标签验证。

## 决策

[PR 策略参考](../../../../.github/issue-management/README.zh.md)负责定义强制范围、标签、可选引用和显式启用配置。必需检查保留 `Issue policy` 名称与评审豁免。纯元数据模块提供标签验证；其只读入口从触发仓库读取 PR 与评审元数据，不导入 Project 配置，也不解析 Issue 引用。

可选 Issue Project 自动化保留生命周期 API 与受信任的默认分支检出。显式启用检查和仓库预检均发生在创建 App token 之前。这样将依赖安装配置的写入与仓库内部必需检查分离，同时为已启用的生命周期操作保留 [Project 局部字段决策](2026-09-02-project-local-issue-planning-fields.zh.md)。

必需检查在普通 `pull_request` 运行中使用当前事件代码和只读仓库 token，使策略修改能在 PR 本身得到评审。发布受信任评审决策的工作流保留独立的可信代码与写入 token 规则。

## 验证

[Issue 管理测试](../../../../.github/issue-management/policy.test.mjs)覆盖标签拒绝与豁免，接受缺少 Issue 引用及独立优先级，并拒绝大写 Priority 别名。[只读 API 测试](../../../../.github/issue-management/pr-policy.test.mjs)拒绝所有 Issue/Project 请求，并验证只使用配置的仓库 token；隔离导入证明必需模块无需 Project 配置也能加载。[工作流测试](../../../../scripts/issue-policy-workflow.spec.ts)固定必需检查名称、当前事件检出、只读权限、显式启用、预检顺序、受信任的生命周期检出和合法事件范围。

## 考虑过的替代方案

**要求每个仓库安装 Project App。** 这能保留 PR 与 Issue 的优先级同步，但管理员安装与变更无关的组织基础设施之前，进入评审的 PR 无法验证标签。

**移除 Issue Project 自动化。** 这会消除配置和写入权限，但会失去运营看板的仓库仍然需要的状态投影与仅 opened 初始化的规划日期。

**仅从默认分支运行 PR 策略。** 受信任代码适用于可写的评审工作流，但只读标签检查将无法在策略修改合并前验证该修改。

## 后果

必需检查无需组织 Project 或 App secret 即可移植。它不证明 PR 存在规划 Issue，也不证明 PR 优先级与看板值一致；这些关系由评审和规划决策负责。运营者必须主动配置并启用 Project 自动化，默认关闭的运行不会修复标签、更新日期或投影状态。
