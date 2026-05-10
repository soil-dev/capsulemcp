# Two-stage build:
#   1. builder: install dev+prod deps, run tsup
#   2. runtime: copy dist + production-only deps
#
# Resulting image is ~150MB on top of node:22-slim. Designed for
# Cloud Run, but works on any container platform.

FROM node:22-slim AS builder
WORKDIR /app

# Install all deps (incl. devDependencies — tsup, typescript)
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Build
COPY tsup.config.ts tsconfig.json ./
COPY src ./src
RUN npx tsup

# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-slim
WORKDIR /app

ENV NODE_ENV=production
# Cloud Run injects PORT but defaulting here keeps local docker run sane.
ENV PORT=8080

# Production-only deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Drop privileges
USER node

EXPOSE 8080
CMD ["node", "dist/http.js"]
