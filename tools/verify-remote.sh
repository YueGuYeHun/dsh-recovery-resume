#!/bin/bash
# verify-remote.sh —— 推送后核对远端内容（走 GitHub API，不走 CDN）
#
# 为什么必须用 API 而不是 raw.githubusercontent.com：
#   实测（2026-09-24）：刚 push 完之后，raw 域名仍返回**上一个提交的内容**
#   （响应头 `cache-control: max-age=300`、`source-age: 7`）。
#   给它加 `?nocache=<时间戳>` 也绕不过 —— CDN 按路径缓存，查询串不参与键。
#   于是"用 raw 核对远端"会得出**假的失败结论**，我这次就差点据此认为推送没生效。
#
# 权威判据（本脚本用的）：
#   1. `git fetch` 后比较本地 HEAD 与 origin/<branch>（git 层，最快）
#   2. GitHub API `contents/<path>?ref=<branch>` 返回的 blob sha 与本地 `git rev-parse HEAD:<path>` 比
#      —— 这个 sha 是 git 对象哈希，内容变一个字节就变，无法糊弄
#   （raw 域名只适合"看个人"的场景，不适合做验收判据）
#
# 用法：
#   bash tools/verify-remote.sh [owner/repo] [branch]
#   默认 owner/repo 从 git remote 里取，branch 默认取当前分支。

set -u

REPO="${1:-}"
BRANCH="${2:-}"

if [ -z "$REPO" ]; then
  # 拆成两步写，不用 `|| { ... }` 那个写法：
  # `{ echo x; exit 1 }` 在 bash 里是**语法错**，`}` 前必须有终结符（`exit 1; }`）。
  # 实测（2026-09-24）：漏了那个分号，整个脚本连 `bash -n` 都过不了。
  url=$(git remote get-url origin 2>/dev/null) || true
  if [ -z "$url" ]; then
    echo "取不到 origin remote"
    exit 1
  fi
  # 从 https://github.com/owner/repo.git 或 git@github.com:owner/repo.git 里取 owner/repo
  REPO=$(printf '%s' "$url" | sed -E 's|^.*github\.com[:/]||' | sed -E 's|\.git$||')
fi
if [ -z "$BRANCH" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null) || BRANCH=main
fi

echo "仓库: $REPO   分支: $BRANCH"
echo

# ── 0. 有没有未推送的东西 ────────────────────────────────────────────────────
git fetch -q origin "$BRANCH" 2>/dev/null || true
ahead=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo "?")
dirty=$(git status --porcelain | wc -l | tr -d ' ')
echo "未推送提交: $ahead    未提交文件: $dirty"
echo

# ── 1. git 层：远端树里的 blob 是否等于本地 ─────────────────────────────────
echo "── 逐文件比对（git blob sha，权威）──"
fail=0
for f in $(git ls-files); do
  # 先问远端这个路径在不在（API 返回 404 说明远端没有）
  api="https://api.github.com/repos/$REPO/contents/$f?ref=$BRANCH"
  remote_sha=$(curl -s "$api" --max-time 30 \
    | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    print(d.get('sha',''))
except Exception:
    print('')
" 2>/dev/null)

  local_sha=$(git rev-parse "HEAD:$f" 2>/dev/null || echo "")

  if [ -z "$remote_sha" ]; then
    printf "  ⚠️  %-30s 远端取不到（API 限流？文件不在远端？）\n" "$f"
    continue
  fi
  if [ "$remote_sha" = "$local_sha" ]; then
    printf "  ✅  %-30s %s\n" "$f" "${local_sha:0:12}"
  else
    printf "  ❌  %-30s 本地 %s ≠ 远端 %s\n" "$f" "${local_sha:0:12}" "${remote_sha:0:12}"
    fail=1
  fi
done
echo

# ── 2. 敏感特征扫描（扫远端真实内容，不是本地）──────────────────────────────
echo "── 远端内容敏感特征扫描 ──"
pattern='/Users/[a-zA-Z]+|sk-[A-Za-z0-9]{20,}|ghp_|github_pat_|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|api[_-]?key=|password=|secret='
hits=0
for f in $(git ls-files); do
  body=$(curl -s "https://api.github.com/repos/$REPO/contents/$f?ref=$BRANCH" --max-time 30 \
    | python3 -c "
import json,sys,base64
try:
    d=json.load(sys.stdin)
    print(base64.b64decode(d['content']).decode('utf-8','replace'))
except Exception:
    pass
" 2>/dev/null)
  n=$(printf '%s' "$body" | grep -cE "$pattern" || true)
  if [ "${n:-0}" -gt 0 ]; then
    printf "  ⚠️  %-30s %s 处可疑\n" "$f" "$n"
    printf '%s' "$body" | grep -nE "$pattern" | head -3 | cut -c1-110 | sed 's/^/       /'
    hits=$((hits+1))
  fi
done
[ "$hits" = 0 ] && echo "  ✅ 无命中"
echo

# ── 3. 结论 ────────────────────────────────────────────────────────────────
if [ "$fail" = 0 ] && [ "$ahead" = "0" ]; then
  echo "结论：远端与本地一致 ✅"
  exit 0
else
  echo "结论：有差异或未推送 ❌（未推送=$ahead）"
  exit 1
fi
