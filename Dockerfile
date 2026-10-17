# Production image: compiled TypeScript, runtime dependencies only (no
# localtunnel), non-root, readiness probe. Serve it behind an HTTPS reverse
# proxy (see deploy/) and pass configuration through the environment, never by
# copying .env.local into the image.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
USER node
EXPOSE 3000
# /ready fails while the database is unreachable; /health only says the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Server and worker in one process; SIGTERM drains in-flight deliveries.
CMD ["node", "dist/cli.js", "start", "--no-tunnel"]
