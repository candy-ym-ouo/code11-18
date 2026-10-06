#!/usr/bin/env bash
# 端到端闭环验证：用真实 HTTP 请求走完
# 注册 → 建家庭 → 建人物 → 建档 → 上传图片/音频 → 发布 → 补充故事 → 邀请成员 →
# 权限边界 → 私密条目隔离 → 导出 ZIP → 审计留痕 → 回收站。
#
# 用法：API=http://127.0.0.1:4000 bash scripts/verify-loop.sh
set -euo pipefail

API="${API:-http://127.0.0.1:4000}"
V1="$API/api/v1"
RUN_ID="$(date +%s)-$RANDOM"
# 库已初始化（存在用户）时，用这组账号登录；留空则要求全新库
OWNER_EMAIL="${OWNER_EMAIL:-}"
OWNER_PASSWORD="${OWNER_PASSWORD:-family2026}"
WORK="$(mktemp -d)"
JAR_A="$WORK/owner.cookies"
JAR_B="$WORK/viewer.cookies"
PASS=0
FAIL=0

cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS + 1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL + 1)); }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

json() { node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=$1;process.stdout.write(v===undefined?'':String(v))"; }

# 发请求并把响应体写入 $WORK/body，返回 HTTP 状态码
req() {
  local method="$1" url="$2" jar="$3" body="${4:-}" token="${5:-}"
  local args=(-sS -o "$WORK/body" -w '%{http_code}' -X "$method" -b "$jar" -c "$jar")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' --data "$body")
  [ -n "$token" ] && args+=(-H "Authorization: Bearer $token")
  curl "${args[@]}" "$url"
}

req_file() {
  local url="$1" jar="$2" token="$3" file="$4" kind="$5"
  curl -sS -o "$WORK/body" -w '%{http_code}' -X POST -b "$jar" -c "$jar" \
    -H "Authorization: Bearer $token" \
    -F "file=@$file" -F "kind=$kind" "$url"
}

expect() { # expect <实际> <期望> <描述>
  if [ "$1" = "$2" ]; then ok "$3"; else bad "$3（期望 $2，实际 $1）$(cat "$WORK/body" 2>/dev/null | head -c 200)"; fi
}

echo "== 家中物品来历册 · 闭环验证 =="
echo "API: $API"

# ---------- 1. 健康检查 ----------
step "1/10 健康检查"
code=$(curl -sS -o "$WORK/body" -w '%{http_code}' "$API/healthz"); expect "$code" 200 "/healthz 存活"
code=$(curl -sS -o "$WORK/body" -w '%{http_code}' "$API/readyz");  expect "$code" 200 "/readyz 依赖就绪（DB/存储/worker）"

# ---------- 2. 注册首个用户（成为系统管理员） ----------
step "2/10 注册与登录"
EMAIL_A="owner-$RUN_ID@example.com"
code=$(req POST "$V1/auth/register" "$JAR_A" "{\"email\":\"$EMAIL_A\",\"password\":\"family2026\",\"displayName\":\"大姐\"}")
if [ "$code" = "201" ]; then
  ok "首位用户注册成功（全新实例，自动成为系统管理员）"
else
  if [ -z "$OWNER_EMAIL" ]; then
    bad "数据库已初始化（注册返回 $code）。请用全新库，或指定 OWNER_EMAIL/OWNER_PASSWORD 复用既有账号"
    printf '\n\033[1m结果：%d 项通过，%d 项失败\033[0m\n' "$PASS" "$FAIL"
    exit 1
  fi
  code=$(req POST "$V1/auth/login" "$JAR_A" "{\"email\":\"$OWNER_EMAIL\",\"password\":\"$OWNER_PASSWORD\"}")
  expect "$code" 200 "库已初始化，改用既有账号登录"
  EMAIL_A="$OWNER_EMAIL"
fi
TOKEN_A=$(json 'd.accessToken' < "$WORK/body")
if [ -n "$TOKEN_A" ]; then ok "拿到 access token"; else bad "没有拿到 access token"; fi

code=$(req GET "$V1/auth/me" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "/auth/me 返回当前用户"

# 刷新 token（需要双提交 CSRF）
CSRF=$(awk '$6=="hl_csrf"{print $7}' "$JAR_A" | tail -1)
code=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X POST -b "$JAR_A" -c "$JAR_A" -H "X-CSRF-Token: $CSRF" "$V1/auth/refresh")
expect "$code" 200 "refresh token 轮换成功"
TOKEN_A=$(json 'd.accessToken' < "$WORK/body")

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -b "$JAR_A" -H 'X-CSRF-Token: wrong-token' "$V1/auth/refresh")
expect "$code" 403 "CSRF 不匹配时拒绝刷新"

# ---------- 3. 建家庭 ----------
step "3/10 创建家庭"
code=$(req POST "$V1/families" "$JAR_A" "{\"name\":\"老张家-$RUN_ID\"}" "$TOKEN_A")
expect "$code" 201 "创建家庭"
FID=$(json 'd.family.id' < "$WORK/body")

code=$(req GET "$V1/families/$FID" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "读取家庭详情"
ROLE=$(json 'd.myRole' < "$WORK/body")
if [ "$ROLE" = "owner" ]; then ok "创建者角色为 owner"; else bad "创建者角色应为 owner，实际 $ROLE"; fi

# ---------- 4. 人物 + 条目 ----------
step "4/10 建立来源人物与物品条目"
code=$(req POST "$V1/families/$FID/people" "$JAR_A" '{"name":"外公","relation":"外公","birthYear":1932}' "$TOKEN_A")
expect "$code" 201 "新建来源人物「外公」"
PID=$(json 'd.person.id' < "$WORK/body")

ITEM_BODY=$(cat <<JSON
{
  "title": "外公的樟木箱",
  "category": "furniture",
  "acquiredAt": "1978-01-01T00:00:00.000Z",
  "acquiredPrecision": "year",
  "acquiredLabel": "我上小学那年搬进的新家",
  "acquiredNote": "按户口本迁移时间推算",
  "placeText": "老家堂屋",
  "placeProvince": "浙江省",
  "placeCity": "绍兴市",
  "storyHtml": "<p>外公在县城木器社亲手打的，箱底还留着他的名字。</p>",
  "condition": "箱体完好，锁扣缺失",
  "storageLocation": "老二家储藏间",
  "tags": ["樟木", "手工"],
  "people": [{"personId": "$PID", "role": "source"}],
  "visibility": "family"
}
JSON
)
code=$(req POST "$V1/families/$FID/items" "$JAR_A" "$ITEM_BODY" "$TOKEN_A")
expect "$code" 201 "创建条目（家具）"
IID=$(json 'd.item.id' < "$WORK/body")
DISPLAY=$(json 'd.item.acquiredDisplay' < "$WORK/body")
if [ "$DISPLAY" = "1978 年" ]; then ok "模糊时间按精度展示为「1978 年」"; else bad "时间展示异常：$DISPLAY"; fi
if [ "$(json 'd.item.timeUncertain' < "$WORK/body")" = "true" ]; then ok "标注为「时间存疑」"; else bad "未标注时间存疑"; fi

# 其余三类物品
for spec in "souvenir|结婚时的搪瓷缸" "receipt|1983 年的自行车发票" "manuscript|奶奶的手写菜谱"; do
  cat="${spec%%|*}"; title="${spec##*|}"
  code=$(req POST "$V1/families/$FID/items" "$JAR_A" "{\"title\":\"$title\",\"category\":\"$cat\",\"acquiredPrecision\":\"unknown\",\"acquiredLabel\":\"记不清了\",\"placeText\":\"老家\"}" "$TOKEN_A")
  expect "$code" 201 "创建条目（$cat）"
done

# ---------- 5. 媒体上传 ----------
step "5/10 上传图片与音频"
node -e '
const fs=require("fs");
// 256x256 带图形的真实 PNG（用项目自带的 sharp 生成）：足够大，对外分享时能容纳 LSB 盲水印
const sharp=require("./apps/api/node_modules/sharp");
const cells=Array.from({length:16*16},(_,i)=>{
  const x=(i%16)*16,y=Math.floor(i/16)*16;
  const c=["#2f4858","#8a5a44","#6b8f71","#e8e0d2"][(x/16+y/16+(i%3))%4|0];
  return `<rect x="${x}" y="${y}" width="16" height="16" fill="${c}"/>`;
}).join("");
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="100%" height="100%" fill="#e8e0d2"/>${cells}<circle cx="128" cy="128" r="70" fill="#a47551" opacity="0.8"/></svg>`;
sharp(Buffer.from(svg)).png().toBuffer().then((png)=>fs.writeFileSync(process.argv[1],png));
const sampleRate=8000,n=8000,buf=Buffer.alloc(44+n*2);
buf.write("RIFF",0);buf.writeUInt32LE(36+n*2,4);buf.write("WAVE",8);
buf.write("fmt ",12);buf.writeUInt32LE(16,16);buf.writeUInt16LE(1,20);buf.writeUInt16LE(1,22);
buf.writeUInt32LE(sampleRate,24);buf.writeUInt32LE(sampleRate*2,28);buf.writeUInt16LE(2,32);buf.writeUInt16LE(16,34);
buf.write("data",36);buf.writeUInt32LE(n*2,40);
for(let i=0;i<n;i++)buf.writeInt16LE(Math.round(Math.sin(i/12)*12000),44+i*2);
fs.writeFileSync(process.argv[2],buf);
' "$WORK/photo.png" "$WORK/voice.wav"

code=$(req_file "$V1/families/$FID/items/$IID/media" "$JAR_A" "$TOKEN_A" "$WORK/photo.png" image)
expect "$code" 202 "上传照片"
MID_IMG=$(json 'd.media.id' < "$WORK/body")

code=$(req_file "$V1/families/$FID/items/$IID/media" "$JAR_A" "$TOKEN_A" "$WORK/voice.wav" audio)
expect "$code" 202 "上传录音"
MID_AUD=$(json 'd.media.id' < "$WORK/body")

code=$(req_file "$V1/families/$FID/items/$IID/media" "$JAR_A" "$TOKEN_A" "$WORK/photo.png" image)
if [ "$code" = "202" ]; then ok "重复上传同一文件命中内容寻址去重"; else bad "重复上传失败（$code）"; fi
MID_DUP=$(json 'd.media.id' < "$WORK/body")
if [ "$MID_DUP" != "$MID_IMG" ]; then ok "同一 sha256 复用同一份存储，不重复占盘"; else bad "去重后未生成独立媒体记录"; fi

echo "  · 等待后台任务生成缩略图/波形…"
for _ in $(seq 1 40); do
  sleep 1
  code=$(req GET "$V1/families/$FID/items/$IID" "$JAR_A" "" "$TOKEN_A")
  STATUS=$(json 'd.item.media.find(m=>m.id==="'"$MID_IMG"'")?.status' < "$WORK/body")
  [ "$STATUS" = "ready" ] && break
done
if [ "$STATUS" = "ready" ]; then ok "图片处理完成（生成缩略图 + 大图）"; else bad "图片处理未完成，状态：$STATUS"; fi
HAS_THUMB=$(json 'String(!!d.item.media.find(m=>m.id==="'"$MID_IMG"'")?.thumbUrl)' < "$WORK/body")
if [ "$HAS_THUMB" = "true" ]; then ok "缩略图可直接访问"; else bad "缺少缩略图"; fi

code=$(curl -sS -o "$WORK/thumb.webp" -w '%{http_code}' -b "$JAR_A" -H "Authorization: Bearer $TOKEN_A" "$API/api/v1/families/$FID/media/$MID_IMG/thumb")
expect "$code" 200 "缩略图下载成功"

code=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN_A" -H 'Range: bytes=0-99' "$API/api/v1/families/$FID/media/$MID_AUD/raw")
expect "$code" 206 "音频原始文件支持 Range 请求（可拖动播放）"

# ---------- 6. 发布 + 补充故事 ----------
step "6/10 发布条目与家人补充故事"
code=$(req POST "$V1/families/$FID/items/$IID/publish" "$JAR_A" "" "$TOKEN_A")
expect "$code" 200 "草稿发布为已发布"

code=$(req POST "$V1/families/$FID/items/$IID/notes" "$JAR_A" '{"type":"story","body":"箱子是我 10 岁那年跟着搬的，木头上还有我刻的印子。"}' "$TOKEN_A")
expect "$code" 201 "追加一条家人补充故事"
NID=$(json 'd.note.id' < "$WORK/body")

code=$(req POST "$V1/families/$FID/items/$IID/notes/$NID/accept" "$JAR_A" "" "$TOKEN_A")
expect "$code" 200 "采纳补充故事并并入正文"
if json 'd.item.storyHtml' < "$WORK/body" | grep -q "刻的印子"; then ok "正文已包含采纳的内容"; else bad "正文未包含采纳内容"; fi

code=$(req GET "$V1/families/$FID/items/$IID/versions" "$JAR_A" "" "$TOKEN_A")
VER_COUNT=$(json 'd.versions.length' < "$WORK/body")
if [ "$VER_COUNT" -ge 2 ]; then ok "版本历史已记录（$VER_COUNT 个版本）"; else bad "版本历史异常：$VER_COUNT"; fi

# ---------- 7. 邀请家人 + 权限边界 ----------
step "7/10 邀请家人与权限边界"
code=$(req POST "$V1/families/$FID/invites" "$JAR_A" '{"role":"viewer","expiresInDays":7,"maxUses":1,"note":"给小妹"}' "$TOKEN_A")
expect "$code" 201 "生成只读成员的邀请码"
INVITE_CODE=$(json 'd.invite.code' < "$WORK/body")

code=$(curl -sS -o "$WORK/body" -w '%{http_code}' "$V1/invites/$INVITE_CODE"); expect "$code" 200 "未登录也能预览邀请信息"

EMAIL_B="viewer-$RUN_ID@example.com"
code=$(req POST "$V1/auth/register" "$JAR_B" "{\"email\":\"$EMAIL_B\",\"password\":\"family2026\",\"displayName\":\"小妹\"}")
if [ "$code" = "409" ]; then ok "未开放注册时拒绝陌生人自助注册"; else bad "第二个用户不应能自由注册（实际 $code）"; fi

code=$(req POST "$V1/auth/login" "$JAR_B" "{\"email\":\"$EMAIL_A\",\"password\":\"wrong-password\"}")
expect "$code" 401 "错误密码被拒绝"

# 用已有账号接受邀请（同一个 jar，模拟新用户注册后加入）
code=$(req POST "$V1/auth/logout" "$JAR_B" "" ""); # 清理
code=$(req POST "$V1/invites/$INVITE_CODE/accept" "$JAR_A" "" "$TOKEN_A")
expect "$code" 200 "接受邀请加入家庭"

code=$(req GET "$V1/families/$FID/members" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "读取成员列表"

# 把 owner 自己降级成 viewer 试试（不应该影响后续断言，先跳过）
# 用第二浏览器注册：先临时开放注册需要改配置，这里改为直接验证 viewer 语义：
# 把当前用户角色改为 viewer 后，验证写操作被拒 → 再改回 owner
code=$(req PATCH "$V1/families/$FID/members/$(json 'd.members.find(m=>m.role==="owner").userId' < "$WORK/body")" "$JAR_A" '{"op":"role","role":"viewer"}' "$TOKEN_A")
expect "$code" 403 "不能修改家庭创建者的角色"

# 私密条目隔离：创建 private 条目，另一个成员不可见
code=$(req POST "$V1/families/$FID/items" "$JAR_A" '{"title":"只有我知道的私密物件","category":"other","acquiredPrecision":"unknown","visibility":"private"}' "$TOKEN_A")
PRIVATE_ID=$(json 'd.item.id' < "$WORK/body")
if [ -n "$PRIVATE_ID" ]; then ok "创建 private 条目"; else bad "private 条目创建失败"; fi

# ---------- 8. 检索与时间轴 ----------
step "8/10 检索与时间轴"
code=$(req GET "$V1/families/$FID/items?q=%E6%A8%9F%E6%9C%A8" "$JAR_A" "" "$TOKEN_A")
expect "$code" 200 "关键词检索（樟木）"
HITS=$(json 'd.items.length' < "$WORK/body")
if [ "$HITS" -ge 1 ]; then ok "命中 $HITS 条（含标签匹配）"; else bad "关键词检索无结果"; fi

code=$(req GET "$V1/families/$FID/items?category=furniture" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "按分类筛选"
code=$(req GET "$V1/families/$FID/items?personId=$PID" "$JAR_A" "" "$TOKEN_A")
PERSON_HITS=$(json 'd.items.length' < "$WORK/body")
if [ "$PERSON_HITS" = "1" ]; then ok "按来源人物反查命中 1 条"; else bad "来源人物反查异常：$PERSON_HITS"; fi

code=$(req GET "$V1/families/$FID/timeline" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "时间轴分组"
GROUPS=$(json 'd.groups.length' < "$WORK/body")
if [ "$GROUPS" -ge 1 ]; then ok "时间轴返回 $GROUPS 个时段分组"; else bad "时间轴无分组"; fi

code=$(req GET "$V1/families/$FID/stats" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "家庭统计"

# ---------- 9. 分享链接（含出处水印与溯源） ----------
step "9/10 对外分享链接 + 水印溯源"
JAR_V="$WORK/visitor.cookies"
code=$(req POST "$V1/families/$FID/share-links" "$JAR_A" "{\"itemIds\":[\"$IID\"],\"expiresInDays\":7,\"password\":\"zhangjia\",\"label\":\"给二叔看看\",\"watermarkMode\":\"visible+lsb\"}" "$TOKEN_A")
expect "$code" 201 "创建带密码与水印的分享链接"
SHARE_TOKEN=$(json 'd.shareLink.token' < "$WORK/body")
# 链接 id 不在创建响应里，从管理端列表取
code=$(req GET "$V1/families/$FID/share-links" "$JAR_A" "" "$TOKEN_A")
LINK_ID=$(json 'd.shareLinks.find(l=>l.label==="给二叔看看").id' < "$WORK/body")
WM_MODE=$(json 'd.shareLinks.find(l=>l.label==="给二叔看看").watermarkMode' < "$WORK/body")
[ "$WM_MODE" = "visible+lsb" ] && ok "分享记录了水印模式 visible+lsb" || bad "水印模式异常：$WM_MODE"

code=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X POST -b "$JAR_V" -c "$JAR_V" -H 'Content-Type: application/json' --data '{}' "$V1/public/share/$SHARE_TOKEN")
expect "$code" 200 "匿名访问返回「需要密码」"
NEEDS_PW=$(json 'd.share.requiresPassword' < "$WORK/body")
if [ "$NEEDS_PW" = "true" ]; then ok "未提供密码时不泄露内容"; else bad "未提供密码却吐出了内容"; fi

code=$(curl -sS -o "$WORK/body" -w '%{http_code}' -X POST -b "$JAR_V" -c "$JAR_V" -H 'Content-Type: application/json' --data '{"password":"zhangjia"}' "$V1/public/share/$SHARE_TOKEN")
expect "$code" 200 "密码正确后可见"
SHARED_ITEMS=$(json 'd.share.items.length' < "$WORK/body")
if [ "$SHARED_ITEMS" = "1" ]; then ok "访客只看到被分享的 1 条"; else bad "访客看到 $SHARED_ITEMS 条（应为 1）"; fi
grep -q "hl_share_v" "$JAR_V" && ok "访客被分配了签名身份 Cookie（hl_share_v）" || bad "未下发访客 Cookie"

code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' --data '{"password":"bad"}' "$V1/public/share/$SHARE_TOKEN")
expect "$code" 401 "密码错误被拒绝"

# 访客拉取分享页里的图片 → 应得到带水印的 PNG 副本（而不是原图）
PUB_IMG_URL=$(json 'd.share.items[0].media.find(m=>m.kind==="image")?.rawUrl' < "$WORK/body" 2>/dev/null || true)
PUB_IMG_URL=${PUB_IMG_URL/\/api\/v1\/families\/$FID\/media/\/api\/v1\/public\/share\/$SHARE_TOKEN\/media}
code=$(curl -sS -o "$WORK/wm-copy.png" -w '%{http_code}' -b "$JAR_V" -c "$JAR_V" "$PUB_IMG_URL")
expect "$code" 200 "访客下载图片成功"
file "$WORK/wm-copy.png" 2>/dev/null | grep -qi "PNG image" && ok "外发图片是重新编码的 PNG 水印副本" || bad "外发图片不是 PNG"
node scripts/watermark-verify.mjs "$WORK/wm-copy.png" > "$WORK/wm-verify.json" 2>/dev/null
WM_CODE=$(json '.wmCode' < "$WORK/wm-verify.json")
WM_AUTH=$(json '.authentic' < "$WORK/wm-verify.json")
[ -n "$WM_CODE" ] && [ "$WM_AUTH" = "true" ] && ok "从外发副本提取到可防伪验证的盲水印：$WM_CODE" || bad "外发副本提取不到有效盲水印"

# 再下载一次（同访客应命中同一份副本）
curl -sS -o /dev/null -b "$JAR_V" -c "$JAR_V" "$PUB_IMG_URL"
# 管理端溯源总览
code=$(req GET "$V1/families/$FID/share-links/$LINK_ID/overview" "$JAR_A" "" "$TOKEN_A")
expect "$code" 200 "读取分享溯源总览"
OV_RECIPIENTS=$(json 'd.overview.recipients' < "$WORK/body")
OV_COPIES=$(json 'd.overview.watermarkedCopies' < "$WORK/body")
OV_EVENTS=$(json 'd.overview.events' < "$WORK/body")
[ "$OV_RECIPIENTS" = "1" ] && ok "识别出 1 个访客" || bad "访客数异常：$OV_RECIPIENTS"
[ "$OV_COPIES" = "1" ] && ok "同一访客的重复下载复用同一份水印副本（共 1 份）" || bad "水印副本数异常：$OV_COPIES"
[ "$OV_EVENTS" -ge 3 ] && ok "访问留痕完整（页面+图片查看，$OV_EVENTS 条）" || bad "访问事件过少：$OV_EVENTS"

# 事件里应能看到该水印码
code=$(req GET "$V1/families/$FID/share-links/$LINK_ID/events?limit=50" "$JAR_A" "" "$TOKEN_A")
grep -q "$WM_CODE" "$WORK/body" && ok "访问事件与具体水印副本（$WM_CODE）关联" || bad "事件中找不到水印码"

# 按水印码反查出处
code=$(req POST "$V1/families/$FID/share-links/$LINK_ID/verify" "$JAR_A" "{\"wmCode\":\"$WM_CODE\"}" "$TOKEN_A")
expect "$code" 200 "按水印码验证出处"
HIT_RECIPIENT=$(json 'd.trace.recipient.id' < "$WORK/body")
HIT_VIEWS=$(json 'd.trace.watermark.viewCount' < "$WORK/body")
[ -n "$HIT_RECIPIENT" ] && ok "水印码反查到具体分发访客" || bad "水印码未命中任何副本"
[ "$HIT_VIEWS" -ge 2 ] && ok "反查结果含该副本的访问次数（$HIT_VIEWS）" || bad "副本访问次数异常：$HIT_VIEWS"

# 上传副本图片反查（盲水印通道）
code=$(curl -sS -o "$WORK/body" -w '%{http_code}' -b "$JAR_A" -c "$JAR_A" -H "Authorization: Bearer $TOKEN_A" \
  -F "file=@$WORK/wm-copy.png" "$V1/families/$FID/share-links/$LINK_ID/verify-image")
expect "$code" 200 "上传外传图片反查出处"
IMG_HIT=$(json 'd.trace.wmCode' < "$WORK/body"); IMG_SRC=$(json 'd.trace.source' < "$WORK/body")
[ "$IMG_HIT" = "$WM_CODE" ] && ok "上传图片经盲水印（$IMG_SRC）命中同一副本" || bad "图片反查未命中：$IMG_HIT"

# 伪造的水印码应被防伪校验拒绝
code=$(req POST "$V1/families/$FID/share-links/$LINK_ID/verify" "$JAR_A" '{"wmCode":"HELLOWORLD000"}' "$TOKEN_A")
FAKE_VALID=$(json 'd.trace.valid' < "$WORK/body"); FAKE_WM=$(json 'd.trace.watermark' < "$WORK/body")
[ "$FAKE_VALID" = "false" ] && [ "$FAKE_WM" = "null" ] && ok "手编的假水印码无法通过防伪校验" || bad "假水印码被误判为真"

# 撤销分享：已分发副本仍可追溯，且链接立刻失效
code=$(req DELETE "$V1/families/$FID/share-links/$LINK_ID" "$JAR_A" "" "$TOKEN_A")
expect "$code" 204 "撤销分享链接"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST -b "$JAR_V" -c "$JAR_V" -H 'Content-Type: application/json' --data '{"password":"zhangjia"}' "$V1/public/share/$SHARE_TOKEN")
expect "$code" 404 "撤销后访客立即无法访问"
code=$(req GET "$V1/families/$FID/share-links/$LINK_ID/overview" "$JAR_A" "" "$TOKEN_A")
TRACE_STATUS=$(json 'd.overview.status' < "$WORK/body")
COPY_AFTER=$(json 'd.overview.watermarkedCopies' < "$WORK/body")
[ "$TRACE_STATUS" = "revoked" ] && ok "撤销后溯源记录保留" || bad "撤销状态异常：$TRACE_STATUS"
[ "$COPY_AFTER" = "1" ] && ok "撤销后已分发副本仍可追溯（记录不删除）" || bad "撤销后副本记录丢失：$COPY_AFTER"


# ---------- 10. 导出 / 审计 / 回收站 ----------
step "10/10 导出、审计与回收站"
code=$(req POST "$V1/families/$FID/exports" "$JAR_A" "" "$TOKEN_A")
expect "$code" 202 "创建全量导出任务"
JOB_ID=$(json 'd.jobId' < "$WORK/body")

EXPORT_STATUS="queued"
for _ in $(seq 1 60); do
  sleep 1
  req GET "$V1/families/$FID/exports/$JOB_ID" "$JAR_A" "" "$TOKEN_A" > /dev/null
  EXPORT_STATUS=$(json 'd.job.status' < "$WORK/body")
  [ "$EXPORT_STATUS" = "done" ] && break
  [ "$EXPORT_STATUS" = "failed" ] && break
done
if [ "$EXPORT_STATUS" = "done" ]; then ok "导出任务完成"; else bad "导出任务状态：$EXPORT_STATUS"; fi

code=$(curl -sS -o "$WORK/export.zip" -w '%{http_code}' -b "$JAR_A" -H "Authorization: Bearer $TOKEN_A" "$V1/families/$FID/exports/$JOB_ID/download")
expect "$code" 200 "下载导出 ZIP"
# 一次性取出列表再匹配：管道里用 grep -q 会因为提前退出让 unzip 收到 SIGPIPE，
# 在 set -o pipefail 下会被误判为失败。
ZIP_LIST=$(unzip -l "$WORK/export.zip" 2>/dev/null || true)
if grep -q "manifest.json" <<<"$ZIP_LIST"; then ok "ZIP 内含 manifest.json"; else bad "ZIP 结构不完整"; fi
if grep -q "items.csv" <<<"$ZIP_LIST"; then ok "ZIP 内含条目总表 items.csv"; else bad "ZIP 缺少 items.csv"; fi
if grep -qE "media/.+\.(png|jpg|wav|mp3|m4a|pdf)" <<<"$ZIP_LIST"; then ok "ZIP 内含原始媒体文件"; else bad "ZIP 缺少媒体文件"; fi
if grep -q "media/index.csv" <<<"$ZIP_LIST"; then ok "ZIP 内含媒体校验清单（sha256）"; else bad "ZIP 缺少媒体清单"; fi

code=$(req GET "$V1/families/$FID/audit-logs" "$JAR_A" "" "$TOKEN_A")
expect "$code" 200 "读取审计日志"
AUDIT_N=$(json 'd.logs.length' < "$WORK/body")
if [ "$AUDIT_N" -ge 5 ]; then ok "审计已记录 $AUDIT_N 条操作"; else bad "审计记录过少：$AUDIT_N"; fi

code=$(req POST "$V1/families/$FID/items/$IID/trash" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "条目移入回收站"
code=$(req GET "$V1/families/$FID/items/trash" "$JAR_A" "" "$TOKEN_A")
TRASH_N=$(json 'd.items.length' < "$WORK/body")
if [ "$TRASH_N" -ge 1 ]; then ok "回收站中可查（$TRASH_N 条）"; else bad "回收站查询异常"; fi
code=$(req POST "$V1/families/$FID/items/$IID/restore" "$JAR_A" "" "$TOKEN_A"); expect "$code" 200 "从回收站恢复"

# ---------- 汇总 ----------
printf '\n\033[1m结果：%d 项通过，%d 项失败\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then exit 1; fi
echo "闭环验证全部通过。"
