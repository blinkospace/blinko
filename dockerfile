# Build Stage
FROM oven/bun:1.2.8 AS builder

# Add Build Arguments
ARG USE_MIRROR=false

WORKDIR /app

# Install CA certificates for SSL connections
RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*

# Set Sharp environment variables to speed up ARM installation
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV PRISMA_SKIP_POSTINSTALL_GENERATE=true

# Copy Project Files
COPY . .

# Configure Mirror Based on USE_MIRROR Parameter
RUN if [ "$USE_MIRROR" = "true" ]; then \
        echo "Using Taobao Mirror to Install Dependencies" && \
        echo '{ "install": { "registry": "https://registry.npmmirror.com" } }' > .bunfig.json && \
        export PRISMA_ENGINES_MIRROR="https://registry.npmmirror.com/-/binary/prisma" && \
        export npm_config_sharp_binary_host="https://npmmirror.com/mirrors/sharp" && \
        export npm_config_sharp_libvips_binary_host="https://npmmirror.com/mirrors/sharp-libvips"; \
    else \
        echo "Using Default Mirror to Install Dependencies"; \
    fi

# Pre-install Sharp for ARM architecture
RUN if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then \
        echo "Detected ARM architecture, installing sharp platform-specific dependencies..." && \
        mkdir -p /tmp/sharp-cache && \
        export SHARP_CACHE_DIRECTORY=/tmp/sharp-cache && \
        bun install --platform=linux --arch=arm64 sharp@0.34.1 --no-save --unsafe-perm || \
        bun install --force @img/sharp-linux-arm64 --no-save; \
    fi

# Install Dependencies and Build App
RUN bun install --unsafe-perm
# Workaround for SSL certificate issues during build
RUN NODE_TLS_REJECT_UNAUTHORIZED=0 bunx prisma generate
RUN bun run build:web
RUN bun run build:seed

RUN printf '#!/bin/sh\necho "Current Environment: $NODE_ENV"\nnpx prisma migrate deploy\nnode server/seed.js\nnode server/index.js\n' > start.sh && \
    chmod +x start.sh


FROM node:20-alpine as init-downloader

WORKDIR /app

RUN wget -qO /app/dumb-init https://github.com/Yelp/dumb-init/releases/download/v1.2.5/dumb-init_1.2.5_$(uname -m) && \
    chmod +x /app/dumb-init && \
    rm -rf /var/cache/apk/*


# Runtime Stage - Using Alpine as required
FROM node:20-alpine AS runner

# Add Build Arguments
ARG USE_MIRROR=false

WORKDIR /app

# Environment Variables
ENV NODE_ENV=production
# If there is a proxy or load balancer behind HTTPS, you may need to disable secure cookies
ENV DISABLE_SECURE_COOKIE=false
# Set Trust Proxy
ENV TRUST_PROXY=1
# Set Sharp environment variables
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV npm_config_sharp_binary_host="https://npmmirror.com/mirrors/sharp"
ENV npm_config_sharp_libvips_binary_host="https://npmmirror.com/mirrors/sharp-libvips"

RUN apk add --no-cache openssl ca-certificates vips-dev python3 py3-setuptools make g++ gcc libc-dev linux-headers && \
    update-ca-certificates && \
    npm config set strict-ssl false && \
    if [ "$USE_MIRROR" = "true" ]; then \
        echo "Using Taobao Mirror to Install Dependencies" && \
        npm config set registry https://registry.npmmirror.com; \
    else \
        echo "Using Default Mirror to Install Dependencies"; \
    fi

# Set SSL-related env vars for npm and node-gyp
ENV NODE_TLS_REJECT_UNAUTHORIZED=0
ENV npm_config_strict_ssl=false

# Copy Build Artifacts and Necessary Files
COPY --from=builder /app/dist ./server
COPY --from=builder /app/server/lute.min.js ./server/lute.min.js
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma/client ./node_modules/.prisma/client
COPY --from=builder /app/start.sh ./
COPY --from=init-downloader /app/dumb-init /usr/local/bin/dumb-init

RUN chmod +x ./start.sh && \
    ls -la start.sh

RUN if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then \
        echo "Detected ARM architecture, installing sharp platform-specific dependencies..." && \
        mkdir -p /tmp/sharp-cache && \
        export SHARP_CACHE_DIRECTORY=/tmp/sharp-cache && \
        npm install --platform=linux --arch=arm64 sharp@0.34.1 --no-save --unsafe-perm || \
        npm install --force @img/sharp-linux-arm64 --no-save; \
    fi

# Install dependencies - use --ignore-scripts for llamaindex to skip tree-sitter native build
RUN echo "Installing additional dependencies..." && \
    npm install @node-rs/crc32 lightningcss sharp@0.34.1 prisma@5.21.1 && \
    npm install -g prisma@5.21.1 && \
    npm install sqlite3@5.1.7 && \
    npm install llamaindex @langchain/community@0.3.40 --ignore-scripts && \
    npm install @libsql/client @libsql/core && \
    npx prisma generate && \
    rm -rf /tmp/* && \
    apk del python3 py3-setuptools make g++ gcc libc-dev linux-headers && \
    rm -rf /var/cache/apk/* /root/.npm /root/.cache

# Expose Port (Adjust According to Actual Application)
EXPOSE 1111

CMD ["/usr/local/bin/dumb-init", "--", "/bin/sh", "-c", "./start.sh"]
