-- Candidate B: ordinary PostgreSQL table-owner privileges only. No event trigger,
-- extension, SUPERUSER, role creation, provider operation or existing-note rewrite.
CREATE TABLE "plugin_note_qualification" (
 "noteId" INTEGER PRIMARY KEY REFERENCES "notes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 "accountId" INTEGER,
 "instance" UUID NOT NULL DEFAULT gen_random_uuid(),
 "version" BIGINT NOT NULL DEFAULT 1,
 "state" TEXT NOT NULL DEFAULT 'dirty' CHECK ("state" IN ('dirty','certified')),
 "snapshotHash" TEXT,
 "usableBody" BOOLEAN,
 "bodyBytes" BIGINT,
 "ruleVersion" TEXT
);
CREATE INDEX "plugin_note_qualification_account_state" ON "plugin_note_qualification"("accountId","state","noteId");
CREATE TABLE "plugin_note_fence" ("accountId" INTEGER PRIMARY KEY,"version" BIGINT NOT NULL DEFAULT 0);
CREATE TABLE "plugin_note_registry" (
 "id" INTEGER PRIMARY KEY CHECK ("id"=1), "trusted" BOOLEAN NOT NULL DEFAULT false, "initializing" BOOLEAN NOT NULL DEFAULT false,
 "schemaSignature" TEXT NOT NULL DEFAULT '', "ruleVersion" TEXT NOT NULL
);
INSERT INTO "plugin_note_registry"("id","ruleVersion") VALUES(1,'body-eligibility-v1');

CREATE FUNCTION blinko_ps_qualification_fence(owner_id INTEGER) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
 IF owner_id IS NOT NULL THEN
  INSERT INTO "plugin_note_fence"("accountId","version") VALUES(owner_id,1)
  ON CONFLICT("accountId") DO UPDATE SET "version"="plugin_note_fence"."version"+1;
 END IF;
END $$;

CREATE FUNCTION blinko_ps_qualification_touch(note_id INTEGER) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE current_owner INTEGER;
BEGIN
 SELECT "accountId" INTO current_owner FROM "notes" WHERE id=note_id;
 IF NOT FOUND THEN RETURN; END IF;
 INSERT INTO "plugin_note_qualification"("noteId","accountId") VALUES(note_id,current_owner)
 ON CONFLICT("noteId") DO UPDATE SET "accountId"=excluded."accountId", "version"="plugin_note_qualification"."version"+1,
 "state"='dirty',"snapshotHash"=NULL,"usableBody"=NULL,"bodyBytes"=NULL,"ruleVersion"=NULL;
 PERFORM blinko_ps_qualification_fence(current_owner);
END $$;

CREATE FUNCTION blinko_ps_note_qualification_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id INTEGER;
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.id,NEW."accountId",NEW.content,NEW."createdAt",NEW."updatedAt",NEW.type,NEW."isArchived",NEW."isRecycle")
  IS NOT DISTINCT FROM ROW(OLD.id,OLD."accountId",OLD.content,OLD."createdAt",OLD."updatedAt",OLD.type,OLD."isArchived",OLD."isRecycle")
 THEN RETURN NEW; END IF;
 IF TG_OP='DELETE' THEN
  PERFORM blinko_ps_qualification_fence(OLD."accountId"); RETURN OLD;
 END IF;
 -- Changing a primary key invalidates both identities even when content is unchanged.
 IF TG_OP='UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN
  DELETE FROM "plugin_note_qualification" WHERE "noteId" IN (OLD.id,NEW.id);
 END IF;
 INSERT INTO "plugin_note_qualification"("noteId","accountId") VALUES(NEW.id,NEW."accountId")
 ON CONFLICT("noteId") DO UPDATE SET "accountId"=excluded."accountId", "version"="plugin_note_qualification"."version"+1,
 "state"='dirty',"snapshotHash"=NULL,"usableBody"=NULL,"bodyBytes"=NULL,"ruleVersion"=NULL;
 FOR owner_id IN SELECT DISTINCT owner FROM unnest(CASE WHEN TG_OP='INSERT' THEN ARRAY[NEW."accountId"] ELSE ARRAY[OLD."accountId",NEW."accountId"] END) owner WHERE owner IS NOT NULL ORDER BY owner
 LOOP PERFORM blinko_ps_qualification_fence(owner_id); END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER blinko_ps_note_qualification_change AFTER INSERT OR UPDATE OR DELETE ON "notes" FOR EACH ROW EXECUTE FUNCTION blinko_ps_note_qualification_change();

CREATE FUNCTION blinko_ps_tag_link_qualification_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN PERFORM blinko_ps_qualification_touch(OLD."noteId"); END IF;
 IF TG_OP<>'DELETE' AND (TG_OP='INSERT' OR NEW."noteId" IS DISTINCT FROM OLD."noteId") THEN
  PERFORM blinko_ps_qualification_touch(NEW."noteId");
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER blinko_ps_tag_link_qualification_change AFTER INSERT OR UPDATE OR DELETE ON "tagsToNote" FOR EACH ROW EXECUTE FUNCTION blinko_ps_tag_link_qualification_change();

-- Tag ownership controls which links count in public scope filters.
CREATE FUNCTION blinko_ps_tag_owner_qualification_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_note INTEGER;
BEGIN
 IF TG_OP='UPDATE' AND NEW."accountId" IS NOT DISTINCT FROM OLD."accountId" AND NEW.id IS NOT DISTINCT FROM OLD.id THEN RETURN NEW; END IF;
 FOR affected_note IN SELECT "noteId" FROM "tagsToNote" WHERE "tagId"=OLD.id ORDER BY "noteId"
 LOOP PERFORM blinko_ps_qualification_touch(affected_note); END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER blinko_ps_tag_owner_qualification_change BEFORE UPDATE OR DELETE ON "tag" FOR EACH ROW EXECUTE FUNCTION blinko_ps_tag_owner_qualification_change();

CREATE FUNCTION blinko_ps_qualification_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE "plugin_note_registry" SET "trusted"=false,"initializing"=false WHERE id=1;
 RETURN NULL;
END $$;
CREATE TRIGGER blinko_ps_note_qualification_truncate BEFORE TRUNCATE ON "notes" FOR EACH STATEMENT EXECUTE FUNCTION blinko_ps_qualification_truncate();
CREATE TRIGGER blinko_ps_tag_link_qualification_truncate BEFORE TRUNCATE ON "tagsToNote" FOR EACH STATEMENT EXECUTE FUNCTION blinko_ps_qualification_truncate();
CREATE TRIGGER blinko_ps_tag_owner_qualification_truncate BEFORE TRUNCATE ON "tag" FOR EACH STATEMENT EXECUTE FUNCTION blinko_ps_qualification_truncate();

-- Every existing note is registered as unknown, never silently certified.
INSERT INTO "plugin_note_qualification"("noteId","accountId") SELECT id,"accountId" FROM "notes";
INSERT INTO "plugin_note_fence"("accountId") SELECT DISTINCT "accountId" FROM "notes" WHERE "accountId" IS NOT NULL ON CONFLICT DO NOTHING;
