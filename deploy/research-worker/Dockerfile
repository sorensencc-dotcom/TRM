# Build stage
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
COPY tsconfig.json ./
RUN npm ci

COPY src ./src
RUN npx tsc

# Runtime stage
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8085

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 8085

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8085/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/protocol/localReferenceWorker.js"]
