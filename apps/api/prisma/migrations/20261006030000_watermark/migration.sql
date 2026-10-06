-- 分享内容出处与水印：已分发副本 + 访问留痕

-- CreateEnum
CREATE TYPE "WatermarkVariant" AS ENUM ('full', 'thumb');

-- CreateEnum
CREATE TYPE "WatermarkContext" AS ENUM ('inline', 'download');

-- CreateTable
CREATE TABLE "watermark_copies" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "media_id" TEXT NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "variant" "WatermarkVariant" NOT NULL,
    "code" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "sig" TEXT NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "watermark_copies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "share_access_events" (
    "id" TEXT NOT NULL,
    "share_link_id" TEXT NOT NULL,
    "visitor_id" TEXT NOT NULL,
    "media_id" TEXT,
    "copy_id" TEXT,
    "context" "WatermarkContext" NOT NULL,
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "share_access_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "watermark_copies_code_key" ON "watermark_copies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "watermark_copies_storage_key_key" ON "watermark_copies"("storage_key");

-- CreateIndex
CREATE UNIQUE INDEX "watermark_copies_share_link_id_visitor_id_media_id_variant_key" ON "watermark_copies"("share_link_id", "visitor_id", "media_id", "variant");

-- CreateIndex
CREATE INDEX "watermark_copies_share_link_id_media_id_idx" ON "watermark_copies"("share_link_id", "media_id");

-- CreateIndex
CREATE INDEX "share_access_events_share_link_id_created_at_idx" ON "share_access_events"("share_link_id", "created_at");

-- CreateIndex
CREATE INDEX "share_access_events_copy_id_idx" ON "share_access_events"("copy_id");

-- CreateIndex
CREATE INDEX "share_access_events_visitor_id_created_at_idx" ON "share_access_events"("visitor_id", "created_at");

-- AddForeignKey
ALTER TABLE "watermark_copies" ADD CONSTRAINT "watermark_copies_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watermark_copies" ADD CONSTRAINT "watermark_copies_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "item_media"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_share_link_id_fkey" FOREIGN KEY ("share_link_id") REFERENCES "share_links"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "share_access_events" ADD CONSTRAINT "share_access_events_copy_id_fkey" FOREIGN KEY ("copy_id") REFERENCES "watermark_copies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
