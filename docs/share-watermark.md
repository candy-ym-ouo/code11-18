# 分享内容出处与水印模块

对外分享的每一张图片都自动带「出处」：可见的家庭名水印 + 隐形的可验编号；
每次查看、下载都留痕；分享撤销后，已经发出去的副本仍然保留，凭一张回流的图片
就能追溯到「哪条链接、哪位访客、哪张原图」。

## 数据模型

- `WatermarkCopy`（`watermark_copies`）：已分发的带水印副本。
  维度唯一键 `(share_link_id, visitor_id, media_id, variant)`——同一位访客在同一条
  链接下打开同一张图，大图 / 缩略图各只有一份副本，不会重复渲染或重复占盘。
  - `code`：6 位十六进制副本短码（对外显示为 `HLxxxxxx`），同时印在可见出处条、
    隐形 DCT 载荷里，并在数据库中唯一。
  - `sig`：短码的 HMAC-SHA256 签名（密钥取 `WATERMARK_HMAC_KEY`，留空回落
    `JWT_SECRET`）。验图时重算比对，防止有人伪造一个短码塞进图片。
- `ShareAccessEvent`（`share_access_events`）：对外访问留痕。页面浏览、图片查看、
  图片下载、音频/文档下载都会写一条，含访客 ID、IP、UA、时间、场景（inline/download）
  与对应副本。
- 撤销分享只把 `share_links.revoked_at` 置位；副本与留痕**不删**。存储 GC 的
  「受引用文件」集合包含所有水印副本键，不会把它们当孤儿清掉。

访客身份：公开分享没有登录态，服务端给每个浏览器下发一年期 HttpOnly cookie
`hl_visitor`，作为水印副本与留痕的归属维度。

## 水印构成（`apps/api/src/media/watermark.ts`）

1. 可见层（sharp + SVG）
   - 斜向 -28° 平铺的家庭名暗纹；
   - 大图底部出处条：`家庭名 · 出处可验 HLxxxxxx · 分享日期`；
   - 缩略图只铺暗纹，避免文字占满小图。
2. 隐形层（8×8 分块 DCT 中频扩频）
   - 载荷 32 bit = 8 bit 魔数 `0x48` + 24 bit 短码；
   - 每个图像块按全局块坐标确定性派生 chip（落在哪个载荷位、+1/−1），对一组中频
     DCT 系数做加性调制；同一位在全图数千个块上重复，解码按 chip 相关累加、
     逐位多数表决；
   - 解码先一次性算出全图块能量表，再做「块编号基（裁剪平移）× 8×8 网格原点」
     对齐搜索，以 8 位魔数 + 数据位归一化置信度锁定正确组合。

实测（1600×1100 照片感测试图）：无损另存、JPEG q95~q60 重压缩、四边裁掉 4%/15%
均可正确验出；渲染约 0.6 秒/张，验图数秒/张（管理端低频操作）。
**局限**：整体大幅缩放（如缩到 50%）、截屏翻拍、叠加大面积遮挡会破坏 8px 块结构，
可能无法恢复——此时仍有可见出处条可人工辨认。这是像素域盲水印的固有边界。

对外图片统一输出**无损 PNG** 且响应 `Cache-Control: no-store`，避免代理缓存把
A 访客的水印副本发给 B 访客。

## 请求路径

对外（无需登录，速率限制 `publicLimiter`，挂访客中间件）：

- `POST /api/v1/public/share/:token` —— 打开分享，写一条页面浏览留痕；
- `GET  /api/v1/public/share/:token/media/:mediaId/raw|thumb|download`
  —— 图片一律现场取/建该访客专属水印副本并留痕；`download` 附带 attachment；
  音频波形 / 音频与文档下载走原文件但同样写留痕（无法嵌像素水印）。

管理端（`share:manage` 权限）：

- `GET  /api/v1/families/:fid/watermarks/share-links/:linkId/copies` —— 已分发副本；
- `GET  /api/v1/families/:fid/watermarks/share-links/:linkId/events` —— 访问留痕；
- `GET  /api/v1/families/:fid/watermarks/copies/:copyId` —— 查看某份实际发出的图；
- `POST /api/v1/families/:fid/watermarks/verify`（multipart `file`，≤30MB 图片）
  —— 上传回流图片，提取隐形短码、验签，返回来源链接/访客/原图/访问次数档案。

## 前端

- 创建分享对话框与公开浏览页都会提示「图片带出处水印、访问留痕、可追溯」；
- 公开页图片地址重写到 `/public/...` 水印通道；
- 家庭设置：每条分享链接有「分发追溯」（副本 + 留痕弹窗），并有「图片水印与
  出处鉴别」卡片上传回流图片验源。
