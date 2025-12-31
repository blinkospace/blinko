-- CreateTable
CREATE TABLE "fonts" (
    "id" SERIAL NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "displayName" VARCHAR(255) NOT NULL,
    "url" TEXT,
    "fileData" BYTEA,
    "isLocal" BOOLEAN NOT NULL DEFAULT false,
    "isSystem" BOOLEAN NOT NULL DEFAULT false,
    "weights" JSON NOT NULL,
    "category" VARCHAR(50) NOT NULL DEFAULT 'sans-serif',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fonts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "fonts_name_key" ON "fonts"("name");
