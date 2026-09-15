CREATE TABLE "noteProcessing" (
    "noteId" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "state" JSONB NOT NULL,
    "token" VARCHAR,
    "leaseUntil" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "noteProcessing_pkey" PRIMARY KEY ("noteId"),
    CONSTRAINT "noteProcessing_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "noteProcessing_status_leaseUntil_idx" ON "noteProcessing"("status", "leaseUntil");
