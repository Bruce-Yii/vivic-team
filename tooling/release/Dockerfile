ARG BASE
FROM ${BASE}
ARG REVISION
LABEL org.opencontainers.image.revision=${REVISION}

# Same three COPY layers as the original Dockerfile: the deployable artifact is
# still "source over the previous image", so a rollback to the previous image is
# unchanged and every historical image stays a valid build base.
COPY --chown=node:node apps/local-api/src/ /app/apps/local-api/src/
COPY --chown=node:node packages/contracts/src/ /app/apps/local-api/node_modules/@vivic/contracts/src/
COPY --chown=node:node packages/card-runtime/src/ /app/apps/local-api/node_modules/@vivic/card-runtime/src/

# Precompile TypeScript to sibling .js (see precompile.mjs). This turns the
# container start from `node --import tsx ...` (runtime transform of ~200 files)
# into `node src/online/index.js` (plain module load).
#
# Failure behaviour: if this RUN fails, the build fails and deploy-v2.sh aborts
# before touching production. If the emitted entry is missing but the build
# somehow succeeded, the deploy script detects it and falls back to tsx.
COPY --chown=node:node precompile.mjs /app/precompile.mjs
USER node
RUN node /app/precompile.mjs /app
# Fail the build if the runtime entry the deploy script will use is absent.
RUN test -f /app/apps/local-api/src/online/index.js
