#!/usr/bin/env bash
# 線上端到端驗證（只讀，不寫入任何資料）。用法：bash scripts/verify-live.sh [網址]
set -u
export MSYS_NO_PATHCONV=1
BASE="${1:-https://djhs-activity-registration.lunary-02c.workers.dev}"
fail=0
STATUS='' BODY=''

# 發出請求並設定 STATUS、BODY（不使用暫存檔，Windows Git Bash 也可執行）
req() {
  local out
  out=$(curl -s -w '\n%{http_code}' --max-time 20 "$@")
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}
# check 說明 期望狀態碼 [內容需包含]
check() {
  if [ "$STATUS" = "$2" ] && { [ -z "${3:-}" ] || printf '%s' "$BODY" | grep -qF "$3"; }; then
    echo "PASS  $1"
  else
    echo "FAIL  $1 (status=$STATUS, body=$(printf '%s' "$BODY" | head -c 160))"; fail=1
  fi
}

req "$BASE/api/health";       check "GET /api/health → 200 ok:true" 200 '"ok":true'
req "$BASE/api/activities";   check "GET /api/activities → 200" 200 '"activities":'
req "$BASE/api/config";       check "GET /api/config → 200" 200 '"authEnabled":'
auth_enabled=0; printf '%s' "$BODY" | grep -qF '"authEnabled":true' && auth_enabled=1
req "$BASE/api/me";           check "GET /api/me（未登入）→ user:null" 200 '"user":null'
req "$BASE/api/nope";         check "GET /api/nope → Worker JSON 404" 404 '"error"'
req -X POST "$BASE/api/activities"; check "POST /api/activities → 405（只讀）" 405
req -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' "$BASE/api/auth/google"
check "跨站 POST /api/auth/google → 403" 403
req -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{"credential":"x.y.z"}' "$BASE/api/auth/google"
if [ $auth_enabled = 1 ]; then check "偽造 token → 401" 401; else check "登入未設定 → 503" 503; fi
req -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{}' "$BASE/api/registrations"
check "未登入報名 → 401" 401
req "$BASE/api/admin/activities"; check "未登入管理 API → 401" 401
req "$BASE/api/my/registrations"; check "未登入我的報名 → 401" 401
req "$BASE/";                 check "GET / → 200 首頁" 200 '活動報名平台'
for p in config.js package.json src/index.js wrangler.jsonc schema.sql gas/Code.gs; do
  req "$BASE/$p"
  if [ "$STATUS" = 200 ]; then echo "FAIL  /$p 不應公開"; fail=1; else echo "PASS  /$p 未公開（$STATUS）"; fi
done
echo "登入功能：$([ $auth_enabled = 1 ] && echo 已啟用 || echo 未設定)"
[ $fail = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
