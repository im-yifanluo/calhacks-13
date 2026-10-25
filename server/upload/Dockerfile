# Build from the repository root: docker build -f server/upload/Dockerfile -t memos-upload .
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8788 UPLOAD_STORAGE=s3
# Install just the root runtime dependencies (S3 signing/transport), not the viewer/GPU pipeline.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --workspaces=false && npm cache clean --force
COPY server/upload/*.mjs ./server/upload/
USER node
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8788)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/upload/start.mjs"]
