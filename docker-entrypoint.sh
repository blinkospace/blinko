#!/bin/sh

set -e

echo "Running Prisma migrations..."
prisma migrate deploy

echo "Seeding database..."
node seed.js

echo "Starting application..."
exec node server.js

