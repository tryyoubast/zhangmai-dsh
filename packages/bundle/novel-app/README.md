---
description: "Add the standalone novel API or worker host to a custom dsh profile with environment-configurable deployment settings."
kind: "package-bundle"
---

# @deepseek-ai/dsh-novel-app

English | [中文](README.zh.md)

## Summary

Use a custom `dsh` profile to run the novel-authoring API or generation worker. This layer supplies the host and its deployment settings without adding chat tools or a browser UI. Set the process mode explicitly and provide the required infrastructure and secrets. The local staging deployment creates standalone profiles for both modes.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use an existing standalone custom profile whose manifest has `dsh.profile.bundles: []` and `patchReload: startup`; the [staging guide](../../../deploy/local-test/README.md) creates the supported API and worker profiles. In a source checkout, these commands add and remove the local bundle:

```sh
node --import tsx/esm apps/cli/src/bin.ts plugin --profile novel-api add link:./packages/bundle/novel-app --offline --ignore-scripts
node --import tsx/esm apps/cli/src/bin.ts plugin --profile novel-api remove @deepseek-ai/dsh-novel-app
```

Successful installation records the dependency and adds the bundle to the profile's layer list; removal removes that layer. Set `DSH_NOVEL_MODE` to `api` or `worker` before launch. Every deployment-varying setting uses a `DSH_NOVEL_*` environment variable in [cordis.patch.yml](cordis.patch.yml), including secret directory, database logins, Redis stream/group, SMTP sender, HTTPS origin, and provider settings.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package declares `dsh.bundle.patch` and inserts exactly one `novel-host` row. It assumes no base-layer row and includes no default chat composition. The [host](../../host/novel-host/README.md) validates the fully evaluated configuration and owns requests, worker execution, and shutdown. The bundle's [module](src/index.ts) has no runtime registrations.

No invariant companion is published because the bundle distributes a static patch and maintains no independent runtime state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Host reference](../../host/novel-host/README.md): identities, queue recovery, health checks, and secrets.
- [Local staging guide](../../../deploy/local-test/README.md): provision and run both profiles.
- [Profile boot](../../boot/app-boot/README.md): profile manifests and patch composition.

-----

<a id="model-experience"></a>
## Model Experience

### Host generation

#### What the model sees

The layer adds `novel-host`; the [host reference](../../host/novel-host/README.md#model-experience) identifies the generation adapter that owns model messages.

#### Token effect

The patch adds no prompt or tool schema. Provider usage comes from worker generation through the host.

#### KV Cache effect

The patch does not mutate model messages or manage a cache; the host's generation adapter owns the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The layer requires an explicit process mode, a standalone startup-only profile, provisioned PostgreSQL/Redis/SMTP, and mounted secrets; it does not initialize those resources.
- The layer inserts the fixed `novel-host` row once. Applying another layer with the same row ID is a composition error.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
