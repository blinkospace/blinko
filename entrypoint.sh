#!/bin/sh
set -e

# Run migrations
prisma migrate deploy

# Run seed script in background and wait
node seed.js &
wait $!

# Now start the main app
exec node server.js

