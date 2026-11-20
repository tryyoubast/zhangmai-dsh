---
description: "将独立小说 API 或 Worker 宿主加入自定义 dsh Profile，并通过环境变量配置部署设置。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-novel-app

[English](README.md) | 中文

## 概述

使用自定义 `dsh` Profile 运行小说创作 API 或生成 Worker。本层提供宿主及其部署设置，不添加聊天工具或浏览器 UI。必须显式设置进程模式，并提供所需基础设施和密钥。本地预发布部署为两种模式分别创建独立 Profile。

## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [当前限制](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

使用已有的独立自定义 Profile，其清单设置 `dsh.profile.bundles: []` 及 `patchReload: startup`；[预发布指南](../../../deploy/local-test/README.zh.md)创建受支持的 API 和 Worker Profile。在源码检出中，以下命令添加或移除本地 Bundle：

```sh
node --import tsx/esm apps/cli/src/bin.ts plugin --profile novel-api add link:./packages/bundle/novel-app --offline --ignore-scripts
node --import tsx/esm apps/cli/src/bin.ts plugin --profile novel-api remove @deepseek-ai/dsh-novel-app
```

安装成功后会记录依赖并将 Bundle 加入 Profile 层列表；移除操作删除该层。启动前把 `DSH_NOVEL_MODE` 设置为 `api` 或 `worker`。[cordis.patch.yml](cordis.patch.yml) 中每项随部署变化的设置均使用 `DSH_NOVEL_*` 环境变量，包括密钥目录、数据库登录、Redis Stream/Group、SMTP 发件人、HTTPS 来源和 Provider 设置。

-----

<a id="understand-the-implementation"></a>
## 实现说明

<details>
<summary>实现细节 — 点击展开</summary>

本包声明 `dsh.bundle.patch`，且仅插入一个 `novel-host` 项。不依赖基础层已有项，也不包含默认聊天组合。[宿主](../../host/novel-host/README.zh.md)校验完成求值的配置，并负责请求、Worker 执行和关闭。Bundle 的[模块](src/index.ts)不注册运行时行为。

本包不发布不变量伴生模块，因为 Bundle 仅分发静态补丁，不维护独立运行时状态。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [宿主参考](../../host/novel-host/README.zh.md)：身份、队列恢复、健康检查与密钥。
- [本地预发布指南](../../../deploy/local-test/README.zh.md)：初始化并运行两种 Profile。
- [Profile 启动](../../boot/app-boot/README.zh.md)：Profile 清单与补丁组合。

-----

<a id="model-experience"></a>
## 模型体验

### 宿主生成

#### What the model sees

本层添加 `novel-host`；[宿主参考](../../host/novel-host/README.zh.md#model-experience)指出负责模型消息的生成适配器。

#### Token effect

补丁不添加提示词或工具 Schema。Provider 用量来自宿主执行的 Worker 生成。

#### KV Cache effect

补丁不修改模型消息或管理缓存；请求前缀由宿主的生成适配器负责。

## 当前限制

<a id="known-limitations-and-deferred-work"></a>

- 本层需要显式进程模式、独立且仅启动时重载的 Profile、已初始化的 PostgreSQL/Redis/SMTP 及已挂载密钥；不会初始化这些资源。
- 本层仅插入一次固定的 `novel-host` 项。其他层使用相同项 ID 会导致组合错误。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
