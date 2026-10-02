# AgentLine gateway — a long-lived process, deliberately.
#
# The gateway holds a gRPC connection to Hedera, serializes registry writes through one
# relayer nonce stream, keeps SSE subscribers open, and runs a health monitor on a timer.
# Those are all things a persistent container does well and a short-lived function does not
# (see DEPLOYMENT.md).
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
# The snapshot store and blob store live here; mount a persistent disk at this path so the
# read model and uploaded media survive a restart. Nothing here is a source of truth —
# everything is rebuildable from Hedera and the registry contract — but rebuilding costs time.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY apps ./apps
COPY packages ./packages
# contracts/out is build output and gitignored, so it does not exist in a fresh clone.
# The gateway does not need it: the registry ABI it loads is committed at
# apps/gateway/src/abi/registry.json. Only the CLI scripts read contracts/out, and those
# run from a developer checkout, never from this image.

USER node
EXPOSE 8402
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8402)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx is a runtime dependency, not a dev tool: it is what executes the gateway. Calling the
# installed binary directly avoids npx reaching for the network on a cold container start.
CMD ["./node_modules/.bin/tsx", "apps/gateway/src/index.ts"]
