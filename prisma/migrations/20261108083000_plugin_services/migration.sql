-- Metadata only. Existing accounts, notes and vectors are untouched.
CREATE TABLE "plugin_service_requests" (
  "id" BIGSERIAL PRIMARY KEY,
  "accountId" INTEGER NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(200) NOT NULL,
  "requestFingerprint" VARCHAR(128) NOT NULL,
  "requestId" VARCHAR(64) NOT NULL,
  "modelId" INTEGER,
  "state" VARCHAR(32) NOT NULL,
  "budgetDay" DATE NOT NULL,
  "reservedTokens" INTEGER NOT NULL DEFAULT 0,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "usageStatus" VARCHAR(16) NOT NULL DEFAULT 'unknown',
  "errorCode" VARCHAR(64),
  "retryAfterMs" INTEGER,
  "timeoutMs" INTEGER NOT NULL,
  "deadlineAt" TIMESTAMPTZ(6) NOT NULL,
  "dispatchStartedAt" TIMESTAMPTZ(6),
  "settledAt" TIMESTAMPTZ(6),
  "outcomeUnknownAt" TIMESTAMPTZ(6),
  "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "plugin_service_requests_state_check" CHECK ("state" IN ('reserved','dispatched','succeeded','failed','outcome_unknown')),
  CONSTRAINT "plugin_service_requests_usage_check" CHECK ("usageStatus" IN ('reported','estimated','unknown')),
  CONSTRAINT "plugin_service_requests_tokens_check" CHECK ("reservedTokens" >= 0 AND ("inputTokens" IS NULL OR "inputTokens" >= 0) AND ("outputTokens" IS NULL OR "outputTokens" >= 0)),
  CONSTRAINT "plugin_service_requests_timeout_check" CHECK ("timeoutMs" > 0)
);
CREATE UNIQUE INDEX "plugin_service_requests_requestId_key" ON "plugin_service_requests"("requestId");
CREATE UNIQUE INDEX "plugin_service_requests_account_operation_key" ON "plugin_service_requests"("accountId","operation","idempotencyKey");
CREATE INDEX "plugin_service_requests_account_created_idx" ON "plugin_service_requests"("accountId","createdAt");
CREATE INDEX "plugin_service_requests_recovery_idx" ON "plugin_service_requests"("state","deadlineAt");

CREATE TABLE "plugin_service_daily_usage" (
  "accountId" INTEGER NOT NULL,
  "day" DATE NOT NULL,
  "reservedTokens" INTEGER NOT NULL DEFAULT 0,
  "settledTokens" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("accountId","day"),
  CONSTRAINT "plugin_service_daily_usage_nonnegative" CHECK ("reservedTokens" >= 0 AND "settledTokens" >= 0)
);

CREATE TABLE "plugin_service_policy" (
  "id" INTEGER NOT NULL DEFAULT 1 PRIMARY KEY,
  "limits" JSON NOT NULL,
  "features" JSON NOT NULL,
  "modelAllowlist" JSON,
  "dailyTokenBudget" INTEGER NOT NULL DEFAULT 200000 CHECK ("dailyTokenBudget" > 0 AND "dailyTokenBudget" <= 5000000),
  "updatedAt" TIMESTAMPTZ(6) NOT NULL,
  "updatedBy" INTEGER,
  CONSTRAINT "plugin_service_policy_singleton" CHECK ("id" = 1)
);
