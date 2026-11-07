# Multi-stage production Dockerfile for Sikho Trading Backend Gateway
# Target: Node.js 20 Alpine for minimal attack surface, high performance & low footprint

# ------------------------------------------------------------------------------
# Stage 1: Build & compile TypeScript packages
# ------------------------------------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache python3 make g++

# Copy workspace package manifests
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/
COPY packages/mobile/package.json ./packages/mobile/

# Install all dependencies (including devDependencies required for compilation)
RUN npm ci

# Copy source code and migration files
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY packages/backend ./packages/backend

# Build shared library first, then backend gateway
RUN npm run build:shared
RUN npm run build:backend

# ------------------------------------------------------------------------------
# Stage 2: Minimal Production Runtime
# ------------------------------------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=4000
ENV HOST=0.0.0.0

# Install dumb-init for proper PID 1 signal forwarding & process reaping in Docker
RUN apk add --no-cache dumb-init curl

# Create non-privileged service user for security
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Copy root package manifests and install only production dependencies
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/backend/package.json ./packages/backend/

RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript and migrations from builder
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/backend/dist ./packages/backend/dist
COPY --from=builder /app/packages/backend/migrations ./packages/backend/migrations

# Assign ownership to non-root appuser
RUN chown -R appuser:appgroup /app

USER appuser

EXPOSE 4000

# Built-in Docker container health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "packages/backend/dist/server.js"]

