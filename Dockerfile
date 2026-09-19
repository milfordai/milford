FROM node:22-alpine AS build
ENV HUSKY=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm build \
 && pnpm --filter @loage/server deploy --prod --legacy /out \
 && pnpm --filter @loage/mcp deploy --prod --legacy /out-mcp

# `docker build --target mcp .` builds the MCP server. It needs `mcp.transport: http` in the config.
FROM node:22-alpine AS mcp
ENV NODE_ENV=production LOAGE_CONFIG=/config/loage.config.yaml
WORKDIR /app
COPY --from=build /out-mcp .
USER node
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8090/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.js"]

# The HTTP server is the default target (the last stage).
FROM node:22-alpine AS server
ENV NODE_ENV=production LOAGE_CONFIG=/config/loage.config.yaml
WORKDIR /app
COPY --from=build /out .
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/cli.js"]
