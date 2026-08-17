FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies

RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/db-ops-api/package.json apps/db-ops-api/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
RUN pnpm install --frozen-lockfile --prod --filter slide-api...

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS production

RUN apk add --no-cache tini \
  && addgroup -S -g 10001 slide \
  && adduser -S -D -H -u 10001 -G slide slide \
  && mkdir -p /var/lib/slide-agent \
  && chown 10001:10001 /var/lib/slide-agent
WORKDIR /workspace
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/db-ops-api/node_modules ./apps/db-ops-api/node_modules
COPY --from=dependencies /workspace/packages/agent-core/node_modules ./packages/agent-core/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/db-ops-api ./apps/db-ops-api
COPY packages/agent-core ./packages/agent-core

ENV NODE_ENV=production
WORKDIR /workspace/apps/db-ops-api
USER 10001:10001
EXPOSE 3000 28888
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "server.ts"]
