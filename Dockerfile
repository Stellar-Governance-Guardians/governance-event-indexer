FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
# `npm run build` runs prebuild first: it unpacks vendor/sgg-parser-wasm-*.tgz
# into generated/parser/nodejs after checking its sha256 against parser.lock.
RUN npm run build
# Fail the image build if any pin drifted (offline, deterministic).
RUN node scripts/check-pins.mjs

FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# The verified parser artifacts are part of the runtime image. Without them
# every event would decode as UNVERIFIED, which is a silent quality regression
# the container smoke test in CI catches.
COPY --from=build /app/generated/parser ./generated/parser
COPY schema ./schema
COPY deployments.json registry.lock schema.lock parser.lock ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
