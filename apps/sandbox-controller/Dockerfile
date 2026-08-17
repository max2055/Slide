FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS dependencies

RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/sandbox-controller/package.json apps/sandbox-controller/package.json
RUN pnpm install --frozen-lockfile --prod --filter slide-sandbox-controller...

FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS production

RUN apk add --no-cache docker-cli tini \
  && addgroup -S -g 10001 slide \
  && adduser -S -D -H -u 10001 -G slide slide
WORKDIR /workspace
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/sandbox-controller/node_modules ./apps/sandbox-controller/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/sandbox-controller ./apps/sandbox-controller
COPY tests/qualification/sandbox-security.ts ./tests/qualification/sandbox-security.ts

ENV NODE_ENV=production HOME=/tmp
WORKDIR /workspace/apps/sandbox-controller
USER 10001:10001
EXPOSE 3010
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
