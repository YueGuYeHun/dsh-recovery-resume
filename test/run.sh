#!/bin/bash
# 跑全部单测。零依赖，不需要 DSH 在运行。
set -u
cd "$(dirname "$0")/.."
rc=0
for f in test/*.test.mjs; do
  echo "════════ $f ════════"
  node "$f" || rc=1
  echo
done
echo "总计：$([ "$rc" = 0 ] && echo '全部通过 ✅' || echo '有失败 ❌')"
exit $rc
