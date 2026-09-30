# 轻量 Node 镜像；better-sqlite3 有预编译二进制，无需构建工具链
FROM node:20-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data

WORKDIR /app

# 如构建环境无法访问 GitHub 下载预编译二进制，可在构建时指定镜像：
#   docker build --build-arg PREBUILT_MIRROR=https://registry.npmmirror.com/-/binary
ARG PREBUILT_MIRROR=

# 先装依赖，利用层缓存
COPY package.json package-lock.json* ./
RUN if [ -n "$PREBUILT_MIRROR" ]; then \
      npm config set better_sqlite3_binary_host "$PREBUILT_MIRROR/better-sqlite3"; \
    fi && npm install --omit=dev

# 拷贝应用代码
COPY server ./server
COPY shared ./shared
COPY public ./public

# SQLite 数据库与上传图片的持久化目录（首次启动自动建表）
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

# 容器内置健康检查：API 可访问即视为就绪
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/projects').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
