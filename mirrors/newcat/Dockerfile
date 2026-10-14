FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY api ./api
RUN npm run build

FROM node:20-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# python3 runs the local REB reader (kit.reb.consult_bundle); openssh-client runs the t4 transport. Packages come from apt only.
# eta-lab is not copied: it is a read-only bind mount (NEWCAT_ETA_LAB_DIR=/eta-lab).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 openssh-client \
 && rm -rf /var/lib/apt/lists/*
ENV PYTHONDONTWRITEBYTECODE=1
USER node
EXPOSE 43123
CMD ["node", "dist/src/worker.js"]
