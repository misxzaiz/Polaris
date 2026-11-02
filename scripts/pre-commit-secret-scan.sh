#!/bin/sh
# Polaris: Pre-commit hook — 拦截暂存区内的疑似密钥泄露
#
# 目的:在 push 前最后关口拦截误贴进源码/handoff 笔记的真实凭据。
#       本次起因:env 输出被整段贴进 .polaris-handoff,含 OpenAI/OpenRouter/Sky 真实 key。
#
# 设计取舍:
#   - 纯 POSIX sh + grep -E,零外部依赖(keyscan 走 MCP,CLI 不在 PATH,无法在 hook 内调用)。
#   - 只扫 staged 内容(git diff --cached),不扫整个工作区 —— 避免误伤历史未跟踪文件。
#   - 命中即拒(非零退出),打印命中行与轮换指引;误报用 --no-verify 绕过或 POLARIS_SKIP_SECRET_SCAN=1。
#   - 只扫 diff 新增行(+),不动删除行;旧文件若未改动不会被扫到。
#
# 安装:cp scripts/pre-commit-secret-scan.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
# (或 git config core.hooksPath scripts/hooks 后放入 scripts/hooks/pre-commit)

# 允许显式跳过(如轮换后清理历史提交时)
if [ -n "$POLARIS_SKIP_SECRET_SCAN" ]; then
    exit 0
fi

# 没有暂存内容直接放行(如空提交、仅 amend message)
STAGED=$(git diff --cached --name-only --diff-filter=AM 2>/dev/null)
if [ -z "$STAGED" ]; then
    exit 0
fi

# 疑似密钥正则:
#   sk-[A-Za-z0-9]{20,}        OpenAI / OpenRouter / Sky 等网关 token(sk- 前缀)
#   sk-ant-[A-Za-z0-9-]{20,}   Anthropic
#   AKIA[0-9A-Z]{16}           AWS access key id
#   AIza[0-9A-Za-z_-]{35}      Google API key
#   ghp_/gho_[A-Za-z0-9]{36}   GitHub PAT / OAuth token
#   glpat-[A-Za-z0-9_-]{20,}   GitLab PAT
#   xox[baprs]-[A-Za-z0-9-]{10,}  Slack token
#   -----BEGIN [A-Z ]*PRIVATE KEY-----  PEM 私钥块
PATTERNS='sk-[A-Za-z0-9]{20,}|sk-ant-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[A-Za-z0-9]{36}|gho_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

HITS=0
REPORT=""

# 逐文件扫 staged 新增行
# 用 while 循环读 diff 输出,提取 + 行去前导加号后匹配
while IFS= read -r file; do
    [ -z "$file" ] && continue
    # 只看该文件 staged diff 的新增行,带行号定位
    MATCHES=$(git diff --cached -- "$file" 2>/dev/null | grep -nE '^\+[^+]' | grep -E "$PATTERNS")
    if [ -n "$MATCHES" ]; then
        HITS=$((HITS + 1))
        REPORT="$REPORT
━━ $file ━━
$MATCHES
"
    fi
done <<EOF
$STAGED
EOF

if [ "$HITS" -gt 0 ]; then
    cat >&2 <<EOF

⛔ pre-commit:检测到疑似密钥泄露,提交已中止($HITS 个文件)

$REPORT

处理方式:
  1. 确认是否真实凭据 —— 若是,先去对应平台 revoke + 轮换,再清理代码中的明文。
  2. 清理后重新 git add 该文件。
  3. 确认为误报或已脱敏的占位符,可用以下任一方式放行:
       git commit --no-verify                      # 本次跳过
       POLARIS_SKIP_SECRET_SCAN=1 git commit ...    # 环境变量跳过

注意:--no-verify 只跳本次,不改变 hook 本身。历史提交若已含真实 key,
      即便后续清理也仍可被 git log 翻出,必须轮换使其失效。
EOF
    exit 1
fi

exit 0
