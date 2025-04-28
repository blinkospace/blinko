# Build Stage
FROM oven/bun:latest AS builder

# Add Build Arguments
ARG USE_MIRROR=false

WORKDIR /app

# Set Sharp environment variables to speed up ARM installation
ENV SHARP_IGNORE_GLOBAL_LIBVIPS=1
ENV npm_config_sharp_binary_host="https://npmmirror.com/mirrors/sharp"
ENV npm_config_sharp_libvips_binary_host="https://npmmirror.com/mirrors/sharp-libvips"

# Copy Project Files
COPY . .

# Configure Mirror Based on USE_MIRROR Parameter
RUN if [ "$USE_MIRROR" = "true" ]; then \
        echo "Using Taobao Mirror to Install Dependencies" && \
        echo '{ "install": { "registry": "https://registry.npmmirror.com" } }' > .bunfig.json; \
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
RUN bun run build:web
RUN bun run build:seed

# Runtime Stage - Using Smaller Base Image
FROM node:20-slim AS runner

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

# Install OpenSSL Dependencies and libvips
RUN apt-get update -y && apt-get install -y openssl libvips-dev && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Copy Build Artifacts and Necessary Files
COPY --from=builder /app/dist ./server
COPY --from=builder /app/server/package.json ./package.json
COPY --from=builder /app/server/lute.min.js ./server/lute.min.js
COPY --from=builder /app/prisma ./prisma

# Prepare Sharp cache directory
RUN mkdir -p /tmp/sharp-cache

# Configure Mirror Based on USE_MIRROR Parameter
RUN if [ "$USE_MIRROR" = "true" ]; then \
        echo "Using Taobao Mirror to Install Dependencies" && \
        npm config set registry https://registry.npmmirror.com; \
    else \
        echo "Using Default Mirror to Install Dependencies"; \
    fi

# Pre-install Sharp for ARM architecture
RUN if [ "$(uname -m)" = "aarch64" ] || [ "$(uname -m)" = "arm64" ]; then \
        echo "Detected ARM architecture, installing sharp platform-specific dependencies..." && \
        mkdir -p /tmp/sharp-cache && \
        export SHARP_CACHE_DIRECTORY=/tmp/sharp-cache && \
        npm install --platform=linux --arch=arm64 sharp@0.34.1 --no-save --unsafe-perm || \
        npm install --force @img/sharp-linux-arm64 --no-save; \
    fi

# Install Production Dependencies
RUN npm install --production
RUN npm install prisma@5.21.1
RUN npx prisma generate

# Remove onnxruntime-node
RUN find / -type d -name "onnxruntime-*" -exec rm -rf {} + || true

# Expose Port (Adjust According to Actual Application)
EXPOSE 1111

# Create Startup Script
RUN echo '#!/bin/sh\n\
echo "Current Environment: $NODE_ENV"\n\
npx prisma migrate deploy\n\
node server/seed.js\n\
node server/index.js' > ./start.sh && chmod +x ./start.sh

# Startup Command
CMD ["./start.sh"]
