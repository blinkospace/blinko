# ---------------------
# Builder Stage
# ---------------------
FROM node:22-alpine AS builder

# Install build dependencies
RUN apk add --no-cache \
    python3 \
    python3-dev \
    py3-setuptools \
    make \
    g++ \
    gcc \
    git \
    openssl-dev \
    openssl \
    build-base \
    sqlite-dev

WORKDIR /app

# Optional: flag for using mirror registry
ARG USE_MIRROR

# Copy package info and install deps
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma

RUN npm install -g pnpm@9.12.2 && \
    if [ "$USE_MIRROR" = "true" ]; then \
        echo "Using mirror registry..." && \
        npm install -g nrm && \
        nrm use taobao; \
    fi && \
    pnpm install

# Generate Prisma client
RUN npx prisma generate

# Copy the rest of the source
COPY . .

# Build the Next.js app and seed data
RUN pnpm build
RUN pnpm build-seed

# Optionally remove onnxruntime if not needed
RUN find /app -type d -name "onnxruntime-node*" -exec rm -rf {} +

# ---------------------
# Runner Stage
# ---------------------
FROM node:22-alpine AS runner

# Install tini and runtime dependencies
RUN apk add --no-cache tini curl tzdata openssl

# Use tini to reap zombies
ENTRYPOINT ["/sbin/tini", "--"]

WORKDIR /app

# Copy only what's needed for runtime
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x ./docker-entrypoint.sh

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/seed.js ./seed.js
COPY --from=builder /app/resetpassword.js ./resetpassword.js

# Optional: copy needed node_modules from .pnpm if required
COPY --from=builder /app/node_modules/.pnpm ./node_modules/.pnpm
COPY --from=builder /app/node_modules/.bin ./node_modules/.bin
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma

# Install Prisma CLI for runtime usage (optional)
RUN npm install -g prisma

# Set runtime env
ENV NODE_ENV=production \
    PORT=1111 \
    HOSTNAME=0.0.0.0

EXPOSE 1111

# Launch app
CMD ["sh", "./docker-entrypoint.sh"]

