-- Drop old scheduledTask table (replaced by pg-boss)
DROP TABLE IF EXISTS "scheduledTask";

-- CreateTable
CREATE TABLE "aiScheduledTask" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "prompt" TEXT NOT NULL,
    "schedule" VARCHAR(100) NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRun" TIMESTAMPTZ(6),
    "lastResult" JSON,
    "accountId" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "aiScheduledTask_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "aiScheduledTask_accountId_idx" ON "aiScheduledTask"("accountId");

-- AddForeignKey
ALTER TABLE "aiScheduledTask" ADD CONSTRAINT "aiScheduledTask_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

