#!/usr/bin/env bash
# edit_file 错误场景演示
# 场景：模型试图编辑一个文件，但 old_string 不匹配
# 修复前：模型看到 tool: ""   （错误遗失）
# 修复后：模型看到 tool: "\nError: old_string not found in ..."

set -e

DEMO_DIR="$(dirname "$0")/edit-error-demo"
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

# ── 1. 创建目标文件 ──
cat > "$DEMO_DIR/target.ts" <<'EOF'
export function hello(): string {
	return "hello world";
}
EOF

echo "=== 1. 目标文件内容 ==="
cat -n "$DEMO_DIR/target.ts"

# ── 2. 模拟 edit_file 调用：old_string 不存在 ──
# 模型错误地用了 "hello earth"（不存在）
echo ""
echo "=== 2. 模拟 edit_file 调用 ==="
echo "   参数: old_string='hello earth', new_string='hello mars'"
echo "   预期: 返回 { content: '', error: 'old_string not found...' }"

# ── 3. 修复前数据流（模拟） ──
echo ""
echo "=== 3a. 修复前 — agentMessages 发给模型 ==="
echo '   { "role": "tool", "content": "", "tool_call_id": "xxx" }'
echo "   → 模型看到空字符串，不知道发生了什么"

# ── 4. 修复后数据流（模拟） ──
echo ""
echo "=== 3b. 修复后 — agentMessages 发给模型 ==="
echo '   { "role": "tool", "content": "\nError: old_string not found in target.ts. File may have been modified since preview — re-read the file.", "tool_call_id": "xxx" }'
echo "   → 模型看到 Error 信息，可以 re-read 文件后重试"

# ── 5. 验证修复后的 toolMessage 构造 ──
echo ""
echo "=== 4. toolMessage 构造逻辑验证 ==="
TOOL_RESULT=""
TOOL_ERROR="old_string not found in target.ts"
TOOL_MESSAGE="${TOOL_RESULT}\nError: ${TOOL_ERROR}"
echo "   toolResult='${TOOL_RESULT}' (空)"
echo "   toolError='${TOOL_ERROR}'"
echo "   toolMessage='${TOOL_MESSAGE}'"

echo ""
echo "=== 完成 ==="
