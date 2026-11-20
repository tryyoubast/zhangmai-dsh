ARG NODE_IMAGE=node:24.14.0-bookworm-slim
FROM ${NODE_IMAGE} AS runtime
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate
WORKDIR /workspace
COPY . .
RUN --mount=type=cache,id=dsh-local-test-pnpm,target=/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --store-dir=/pnpm/store --fetch-retries=5 --fetch-timeout=180000 \
    && pnpm run build:lib:host
ENV NODE_ENV=production
CMD ["node", "apps/cli/lib/bin.js", "--profile", "novel-api"]
