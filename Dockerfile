FROM node:20-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

FROM node:20-bookworm-slim AS prod-deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production \
  && yarn cache clean

FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV MCP_PROJECT_BRIDGE_DB=/data/bridge.sqlite
ENV MCP_PROJECT_BRIDGE_HOST=0.0.0.0

RUN mkdir -p /data

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json README.md ./

VOLUME ["/data"]

EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
