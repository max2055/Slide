FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS supported-platform

# The bundled Oracle Instant Client is Linux ARM64 only. Check the actual
# image architecture (not an overridable build argument) before installing.
RUN test "$(dpkg --print-architecture)" = arm64 \
  || { echo 'Slide API supports linux/arm64 only: Oracle Instant Client is ARM64; linux/amd64 is unsupported.' >&2; exit 1; }

FROM supported-platform AS dependencies

RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/db-ops-api/package.json apps/db-ops-api/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
RUN pnpm install --frozen-lockfile --prod --filter slide-api...

FROM supported-platform AS oracle-client

RUN apt-get update \
  && apt-get install -y --no-install-recommends libaio1 unzip \
  && rm -rf /var/lib/apt/lists/*
COPY oracle-client-build/instantclient-basic-linux.arm64-19.19.0.0.0dbru.zip /tmp/oracle-instantclient.zip
RUN mkdir -p /opt/oracle \
  && unzip -q /tmp/oracle-instantclient.zip -d /opt/oracle \
  && mv /opt/oracle/instantclient_19_19 /opt/oracle/instantclient \
  && rm /tmp/oracle-instantclient.zip

FROM supported-platform AS production

RUN apt-get update \
  && apt-get install -y --no-install-recommends libaio1 tini git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && addgroup --system --gid 10001 slide \
  && adduser --system --disabled-login --no-create-home --uid 10001 --ingroup slide slide \
  && mkdir -p /var/lib/slide-agent \
  && chown 10001:10001 /var/lib/slide-agent
COPY --from=oracle-client /opt/oracle/instantclient /opt/oracle/instantclient
WORKDIR /workspace
COPY --from=dependencies /workspace/node_modules ./node_modules
COPY --from=dependencies /workspace/apps/db-ops-api/node_modules ./apps/db-ops-api/node_modules
COPY --from=dependencies /workspace/packages/agent-core/node_modules ./packages/agent-core/node_modules
COPY package.json pnpm-workspace.yaml ./
COPY apps/db-ops-api ./apps/db-ops-api
COPY packages/agent-core ./packages/agent-core
COPY apps/db-ops-skills ./apps/db-ops-skills

ENV NODE_ENV=production
ENV NODE_ORACLEDB_DRIVER_MODE=thick
ENV NODE_ORACLEDB_CLIENT_LIB_DIR=/opt/oracle/instantclient
ENV LD_LIBRARY_PATH=/opt/oracle/instantclient
WORKDIR /workspace/apps/db-ops-api
USER 10001:10001
# Load the real client as the runtime user; no database connection is needed.
RUN node -e "const o = require('oracledb'); o.initOracleClient({libDir: process.env.NODE_ORACLEDB_CLIENT_LIB_DIR}); if (o.thin) throw new Error('Oracle thick mode required'); console.log('Oracle thick client:', o.oracleClientVersionString, 'arch:', process.arch);"
EXPOSE 3000 28888
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "server.ts"]
