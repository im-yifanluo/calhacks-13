# The upload API (Node, S3/R2 storage). Build from the repository root:
#   docker build -f server/upload/deploy/docker/Dockerfile -t memos-upload .
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8788 UPLOAD_STORAGE=s3 UPLOAD_HOST=0.0.0.0
# Install only the upload service's runtime dependencies, not the viewer or the GPU pipeline.
COPY package.json package-lock.json ./
COPY server/upload/package.json ./server/upload/
RUN npm ci --omit=dev --ignore-scripts --workspace server/upload && npm cache clean --force
COPY server/upload/src ./server/upload/src
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/upload/src/node/server.mjs"]
