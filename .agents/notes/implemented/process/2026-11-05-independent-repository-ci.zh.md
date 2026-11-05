# Agent Note: 独立仓库 CI 默认设置与可选集成

Status: implemented

[English](2026-11-05-independent-repository-ci.md) | 中文

## 问题

拉取请求检查需要可靠的标准托管容量，同时保留运行器故障时的恢复路径。预览部署和 Project 自动化也依赖仓库专属的写入凭据，而 fork 拉取请求无法获得这些凭据。

要求使用大型运行器或外部应用凭据会提高日常检查成本，并使仓库策略依赖可选集成。工作流需要在不向不可信变更授予部署或 Project 写入权限的情况下保持验证可用。

## 决策

主要拉取请求 Linux 作业使用 GitHub 托管的 `ubuntu-24.04`；原生 Windows 作业使用 `windows-2025`。标准运行器配置采用适度的门禁并发、两个插桩覆盖率分区，以及上限为 2 的快照并发。现有的 `DSH_CI_FAILOVER_LINUX` 和 `DSH_CI_FAILOVER_WINDOWS` 开关仍可通过 `selfhosted` 路由到内部运行器池，或通过 `blacksmith` 路由到 Blacksmith；自托管信任条件和 Dependabot 托管回退保持不变。[故障切换手册](2026-07-26-ci-failover-runbook.zh.md)负责恢复细节，[原生 Windows CI 笔记](2026-08-08-native-windows-pull-request-ci.zh.md)保留平台专属的执行依据。

`all checks passed` 清单仍包含必需的 PostgreSQL 18 auth 作业，以及现有 Linux、Windows、Node 兼容性和 Python 依赖。CI、安全与评审检查继续承担既有职责。master 自托管 standby 作业仅在 `DSH_SELFHOSTED_STANDBY_ENABLED == 'true'` 时于 master 推送运行；它们仍是诊断证据，不进入拉取请求检查面板。加权人工批准和评审人归属保持不变，分别由[批准策略](../../../../.github/review-ownership/README.md)和[加权批准决策](2026-09-09-blocked-weighted-approvals-remain-pending.zh.md)负责。

[Cloudflare 预览工作流](../../../../.github/workflows/build-preview-cloudflare.yml)始终在 `ubuntu-24.04` 上为拉取请求构建并验证。准确名为 `cloudflare pages preview` 的检查仅构建。部署需要 `DSH_PREVIEW_DEPLOY_ENABLED == 'true'`、同仓库拉取请求、匹配的 Cloudflare 目标配置以及已配置的部署密钥。fork 拉取请求绝不部署，并会收到仅构建的摘要。

[Issue policy 工作流](../../../../.github/workflows/issue-policy.yml)检出仓库默认分支，禁用检出凭据持久化，并使用只读的当前仓库 REST 权限执行拉取请求和 Issue 策略检查。[Issue lifecycle 工作流](../../../../.github/workflows/issue-lifecycle.yml)仅在 `DSH_PROJECT_AUTOMATION_ENABLED == 'true'` 时启用 Project App token 路径；启用后，必需的仓库和 Project 配置必须与 `GITHUB_REPOSITORY` 匹配，并且必须配置 App client ID 与私钥。Project mutation 会跳过 fork 拉取请求及其评审事件；默认拉取请求策略仍仅依赖仓库。

## 验证

[CI 路由测试](../../../../scripts/tests/ci-runner-defaults.spec.ts)和[工作流测试](../../../../scripts/ci-workflow.spec.ts)固定标准默认值、故障切换路由、必需检查和 standby opt-in。[预览工作流测试](../../../../scripts/preview-workflow.spec.ts)固定仅构建验证与同仓库部署条件。Issue 管理测试覆盖仓库策略及启用后的 Project 生命周期配置与 mutation。

## 考虑过的替代方案

- **让每个拉取请求都使用大型托管运行器。**这可以缩短实测作业时间，但会把大型运行器容量消耗在日常工作上，并让必需路径依赖专用池；现有开关仍提供大型容量的故障切换路径。
- **每次 master 推送都运行 master standby。**持续演练会产生更多就绪数据，但在运维人员尚未启用时仍会占用内部共享容量；显式开关让这些作业保持 opt-in。
- **为所有预览部署，包括 fork 拉取请求。**这能让每个变更都获得预览 URL，但会让不可信拉取请求代码接触部署凭据；无条件构建仍提供验证，同仓库 opt-in 则限制写入。
- **让拉取请求策略强制依赖 Project 集成。**这能让策略读取 board 字段，但要求每个仓库配置 App 与 Project，并让只读检查依赖外部目标；仓库 REST 保持自包含的默认方式，生命周期写入仍为可选。

## 后果

日常拉取请求检查在标准 GitHub 托管镜像上以有界并发运行，而高容量路由仍是显式的恢复选择。标准配置可能比实测的大型运行器配置耗时更长；运维人员必须先启用并监控 master standby，才能用其结果判断就绪状态。

每个拉取请求仍会接受预览构建验证，但 fork 不会获得部署 URL。启用 Cloudflare 或 Project 自动化的仓库必须维护匹配的目标配置和凭据。Project 生命周期日期和字段变更在启用前保持停用；仅仓库级 Issue 策略和加权人工批准不依赖这些集成。
