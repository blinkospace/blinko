CREATE TABLE "plugin_service_rate" (
  "accountId" INTEGER NOT NULL,
  "windowStart" TIMESTAMPTZ(6) NOT NULL,
  "used" INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY ("accountId", "windowStart"),
  CONSTRAINT "plugin_service_rate_nonnegative" CHECK ("used" >= 0)
);
CREATE INDEX "plugin_service_rate_window_idx" ON "plugin_service_rate" ("windowStart");
ALTER TABLE "plugin_service_policy" ADD COLUMN "maxRequestsPerMinute" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "plugin_service_policy" ADD CONSTRAINT "plugin_service_policy_rate_range" CHECK ("maxRequestsPerMinute" BETWEEN 1 AND 240);
