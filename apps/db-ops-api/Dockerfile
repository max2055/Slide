FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS dependencies

RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/db-ops-api/package.json apps/db-ops-api/package.json
COPY packages/agent-core/package.json packages/agent-core/package.json
RUN pnpm install --frozen-lockfile --prod --filter slide-api...

FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS oracle-client

RUN apt-get update \
  && apt-get install -y --no-install-recommends libaio1 unzip \
  && rm -rf /var/lib/apt/lists/*
COPY oracle-client-build/instantclient-basic-linux.arm64-19.19.0.0.0dbru.zip /tmp/oracle-instantclient.zip
RUN mkdir -p /opt/oracle \
  && unzip -q /tmp/oracle-instantclient.zip -d /opt/oracle \
  && mv /opt/oracle/instantclient_19_19 /opt/oracle/instantclient \
  && rm /tmp/oracle-instantclient.zip

FROM node@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS production

RUN apt-get update \
  && apt-get install -y --no-install-recommends libaio1 tini \
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
EXPOSE 3000 28888
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./node_modules/.bin/tsx", "server.ts"]
