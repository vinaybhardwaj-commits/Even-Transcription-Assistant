# Even Scribe Ambient Brain — Cloud Run image (skeleton, PRD step 1).
# Two-stage: compile TypeScript with dev deps, ship only dist/ + prod deps (pg).
# Build context is the brain/ directory:  gcloud run deploy ... --source brain

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
USER node
# Cloud Run injects PORT (default 8080); server.ts reads it.
EXPOSE 8080
CMD ["node", "dist/server.js"]
