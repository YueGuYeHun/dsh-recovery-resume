#!/bin/bash
# verify-remote.sh —— 推送后核对远端内容是否与本地一致
#
# 为什么不用 raw.githubusercontent.com：它 CDN 缓存 5 分钟（`max-age=300`），
#   刚 push 完仍返回**上一个提交**的内容，实测害我误判过一次"推送没生效"。
# 为什么不用 GitHub API：有配额（未认证 60/小时）。实测跑满过，逐文件比对
#   全变成"取不到"，而旧版那时**仍然打印"一致"** —— 比限流更糟。
#
# 现在走 git + gh：`git fetch` 后远端对象就在本地 `.git` 里，用
#   `git rev-parse <remote>/<branch>:<path>` 比对即可，无限流。
#   需要查 GitHub 元数据时用 `gh api`（已认证，5000/小时）。
#
# 硬约束：任何文件取不到 -> fail=1；结论要求「核对数 == 跟踪文件数」。

set -u

REMOTE="${1:-origin}"
BRANCH="${2:-main}"

echo "远端: $REMOTE   分支: $BRANCH"
echo

git fetch -q "$REMOTE" "$BRANCH" 2>/dev/null || true
if ! git rev-parse --verify -q "$REMOTE/$BRANCH" >/dev/null; then
  echo "取不到 $REMOTE/$BRANCH"
  exit 1
fi

ahead=$(git rev-list --count "$REMOTE/$BRANCH"..HEAD 2>/dev/null || echo "?")
echo "未推送提交: $ahead    未提交文件: $(git status --porcelain | wc -l | tr -d ' ')"
echo

echo "-- 逐文件比对（git blob sha）--"
fail=0
missing=0
checked=0
while IFS= read -r f; do
  local_sha=$(git rev-parse "HEAD:$f" 2>/dev/null)
  remote_sha=$(git rev-parse "$REMOTE/$BRANCH:$f" 2>/dev/null)
  if [ -z "$local_sha" ]; then
    printf "  [!] %-30s 本地没有\n" "$f"; fail=1; continue
  fi
  if [ -z "$remote_sha" ]; then
    printf "  [X] %-30s 远端缺失\n" "$f"; missing=$((missing+1)); fail=1; continue
  fi
  checked=$((checked+1))
  if [ "$local_sha" = "$remote_sha" ]; then
    printf "  [ok] %-30s %s\n" "$f" "${local_sha:0:12}"
  else
    printf "  [X]  %-30s 本地 %s != 远端 %s\n" "$f" "${local_sha:0:12}" "${remote_sha:0:12}"
    fail=1
  fi
done < <(git ls-files)
echo

echo "-- 远端内容敏感特征扫描 --"
PATTERN='/Users/[a-zA-Z]+|sk-[A-Za-z0-9]{20,}|ghp_|gho_|github_pat_|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|api[_-]?key=|password=|secret='
while IFS= read -r f; do
  body=$(git show "$REMOTE/$BRANCH:$f" 2>/dev/null) || { printf "  [X] %-30s 取不到\n" "$f"; fail=1; continue; }
  n=$(printf '%s' "$body" | grep -vE '^[[:space:]]*PATTERN=' | grep -cE "$PATTERN" || true)
  if [ "${n:-0}" -gt 0 ]; then
    printf "  [!] %-30s %s 处可疑\n" "$f" "$n"
    printf '%s' "$body" | grep -vE '^[[:space:]]*PATTERN=' | grep -nE "$PATTERN" | head -3 | cut -c1-110 | sed 's/^/       /'
    fail=1
  fi
done < <(git ls-files)
echo

total=$(git ls-files | wc -l | tr -d ' ')
echo "----------------------------------------"
if [ "$fail" = 0 ] && [ "$ahead" = "0" ] && [ "$checked" = "$total" ]; then
  echo "结论：远端与本地一致（$checked/$total 个文件逐字节核对，未推送 0）"
  exit 0
fi
echo "结论：不一致或未完成（核对 $checked/$total，未推送 $ahead，远端缺失 $missing）"
exit 1
