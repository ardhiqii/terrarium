# syntax=docker/dockerfile:1

# ---------- build stage ----------
FROM node:22-alpine AS build
WORKDIR /app
# Copy manifests first so dep install layers cache well
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund

# Copy the app + config (the web app lives under apps/web; the Dockerfile stays
# at repo root so the build context is the whole repo)
COPY apps ./apps

# Build produces .next/standalone (output: "standalone" in next.config.ts)
RUN npm run build

# ---------- runtime stage ----------
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3101
ENV HOSTNAME=0.0.0.0

# Copy the entire standalone bundle, preserving its internal structure
# (server.js at apps/web/server.js, node_modules at /app/node_modules).
COPY --from=build /app/apps/web/.next/standalone/ ./
# Static + public assets are served relative to the app dir (apps/web).
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3101
CMD ["node", "apps/web/server.js"]
