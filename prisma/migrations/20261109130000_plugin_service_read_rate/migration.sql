-- Keep existing account/window rows and their total usage. Before this migration
-- no reliable operation classification existed. The gate conservatively charges
-- used-readNoteUsed-sharedUsed against either lane until that window expires.
ALTER TABLE "plugin_service_rate"
  ADD COLUMN "readNoteUsed" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "sharedUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "plugin_service_rate"
  ADD CONSTRAINT "plugin_service_rate_classified_counts"
  CHECK ("readNoteUsed" >= 0 AND "sharedUsed" >= 0
         AND "readNoteUsed" + "sharedUsed" <= "used");

-- NULL is combined/legacy admission, including for existing and missing rows.
-- Only an explicit administrator value enables a separate, bounded read lane.
ALTER TABLE "plugin_service_policy"
  ADD COLUMN "readNoteRequestsPerMinute" INTEGER;
ALTER TABLE "plugin_service_policy"
  ADD CONSTRAINT "plugin_service_policy_read_rate_range"
  CHECK ("readNoteRequestsPerMinute" IS NULL
         OR "readNoteRequestsPerMinute" BETWEEN 1 AND 20);
