-- 分享内容出处与水印模块：访客留痕、逐访客水印副本、访问事件

-- AlterEnum
ALTER TYPE "JobType" ADD VALUE IF NOT EXISTS 'watermark_cleanup';

-- AlterTable
ALTER TABLE "share_links" ADD COLUMN "watermark_mode" TEXT NOT NULL DEFAULT 'visible+lsb';

-- CreateTable
CREATE TABLE "share_recipients" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "cookie_hash" TEXT NOT NULL,
    "label" TEXT,
    "first_ip" TEXT,
    "last_ip" TEXT,
    "first_user_agent" TEXT,
    "last_user_agent" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "blocked_at" TIMESTAMP(3),

    CONSTRAINT "share_recipients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_watermarks" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "wm_code" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "download_count" INTEGER NOT NULL DEFAULT 0,
    "last_access_at" TIMESTAMP(3),
    "file_purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_watermarks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_access_events" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "family_id" TEXT NOT NULL,
    "recipient_id" TEXT,
    "watermark_id" TEXT,
    "media_id" TEXT,
    "kind" TEXT NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "byte_size" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "share_recipients_cookie_hash_key" ON "share_recipients"("cookie_hash");
CREATE INDEX "share_recipients_share_link_id_first_seen_at_idx" ON "share_recipients"("share_link_id", "first_seen_at");
CREATE INDEX "share_recipients_family_id_idx" ON "share_recipients"("family_id");

-- CreateIndex
CREATE UNIQUE INDEX "share_watermarks_wm_code_key" ON "share_watermarks"("wm_code");
CREATE UNIQUE INDEX "share_watermarks_recipient_id_media_id_key" ON "share_watermarks"("recipient_id", "media_id");
CREATE INDEX "share_watermarks_share_link_id_idx" ON "share_watermarks"("share_link_id");
CREATE INDEX "share_watermarks_family_id_idx" ON "share_watermarks"("family_id");

-- CreateIndex
CREATE INDEX "share_access_events_share_link_id_created_at_idx" ON "share_access_events"("share_link_id", "created_at");
CREATE INDEX "share_access_events_family_id_created_at_idx" ON "share_access_events"("family_id", "created_at");
CREATE INDEX "share_access_events_recipient_id_created_at_idx" ON "share_access_events"("recipient_id", "created_at");

-- AddForeignKey
ALTER TABLE "share_recipients" ADD CONSTRAINT "share_recipients_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_recipients" ADD CONSTRAINT "share_recipients_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "share_watermarks" ADD CONSTRAINT "share_watermarks_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_watermarks" ADD CONSTRAINT "share_watermarks_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "share_recipients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_watermarks" ADD CONSTRAINT "share_watermarks_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "share_recipients"("id") ON DELETE DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_watermark_id_fkey" FOREIGN KEY ("watermark_id") REFERENCES "share_watermarks"("id") ON DELETE SET NULL ON UPDATE CASCADE;
