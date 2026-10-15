#!/usr/bin/env bash
# 線上端到端驗證（只讀，不寫入任何資料）。用法：bash scripts/verify-live.sh [網址]
set -u
export MSYS_NO_PATHCONV=1
BASE="${1:-https://djhs-activity-registration.lunary-02c.workers.dev}"
fail=0
check() { # 說明 期望狀態碼 實際狀態碼 [內容需包含]
  local desc="$1" want="$2" got="$3" body="${4:-}" need="${5:-}"
  if [ "$got" = "$want" ] && { [ -z "$need" ] || printf '%s' "$body" | grep -q "$need"; }; then
    echo "PASS  $desc"
  else
    echo "FAIL  $desc (status=$got, body=$(printf '%s' "$body" | head -c 160))"; fail=1
  fi
}
req() { curl -s -o /tmp/djhs_body -w '%{http_code}' --max-time 20 "$@"; }

s=$(req "$BASE/api/health");      check "GET /api/health → 200 ok:true" 200 "$s" "$(cat /tmp/djhs_body)" '"ok":true'
s=$(req "$BASE/api/activities");  check "GET /api/activities → 200" 200 "$s" "$(cat /tmp/djhs_body)" '"activities":'
s=$(req "$BASE/api/config");      check "GET /api/config → 200" 200 "$s" "$(cat /tmp/djhs_body)" '"authEnabled":'
s=$(req "$BASE/api/me");          check "GET /api/me（未登入）→ user:null" 200 "$s" "$(cat /tmp/djhs_body)" '"user":null'
s=$(req "$BASE/api/nope");        check "GET /api/nope → Worker JSON 404" 404 "$s" "$(cat /tmp/djhs_body)" '"error"'
s=$(req -X POST "$BASE/api/activities"); check "POST /api/activities → 405（只讀）" 405 "$s"
s=$(req -X POST -H 'content-type: application/json' -H 'origin: https://evil.example' -d '{}' "$BASE/api/auth/google")
check "跨站 POST /api/auth/google → 403" 403 "$s"
s=$(req -X POST -H 'content-type: application/json' -H "origin: $BASE" -d '{"credential":"x.y.z"}' "$BASE/api/auth/google")
if grep -q '"authEnabled":true' <(curl -s "$BASE/api/config"); then
  check "偽造 token → 401" 401 "$s"
else
  check "登入未設定 → 503" 503 "$s"
fi
s=$(req "$BASE/");                check "GET / → 200 首頁" 200 "$s" "$(cat /tmp/djhs_body)" '活動報名平台'
for p in config.js package.json src/index.js wrangler.jsonc schema.sql gas/Code.gs; do
  s=$(req "$BASE/$p"); [ "$s" = 200 ] && { echo "FAIL  /$p 不應公開"; fail=1; } || echo "PASS  /$p 未公開（$s）"
done
[ $fail = 0 ] && echo "ALL PASS" || { echo "SOME CHECKS FAILED"; exit 1; }
