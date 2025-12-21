-- CreateTable
CREATE TABLE "mcpServers" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "description" TEXT,
    "type" VARCHAR(50) NOT NULL,
    "command" TEXT,
    "args" JSON,
    "url" VARCHAR(500),
    "env" JSON,
    "headers" JSON,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "mcpServers_pkey" PRIMARY KEY ("id")
);
