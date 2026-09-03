#!/usr/bin/env python3
"""
Polaris 内置浏览器 MCP 协议直连验证脚本
纯外部测试，不改动项目代码。

用法:
    python scripts/test_browser_mcp.py

原理:
    1. 从 .polaris/claude/mcp.json 读取运行时 port + token
    2. 模拟 browser_mcp_server.rs 的 request_browser_via_tcp()
       构造 {type:"browser", token, callId, action, args} 帧
       发送到 127.0.0.1:{port}
    3. 读取返回的 {type:"browser_result", ok, result/error}
    4. 逐个验证现有 action 是否可调用

帧格式(与 Rust 侧一致):
    [4字节小端 u32 长度][JSON body]
"""

import json
import socket
import struct
import sys
import time
from pathlib import Path

# Windows 控制台 UTF-8 输出
if sys.platform == "win32":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

WORKSPACE = Path(__file__).resolve().parent.parent
MCP_CONFIG = WORKSPACE / ".polaris" / "claude" / "mcp.json"

# 帧最大长度(与 Rust 侧 MAX_FRAME_SIZE 一致)
MAX_FRAME_SIZE = 16 * 1024 * 1024


def load_port_token() -> tuple[int, str]:
    """从 mcp.json 提取 polarisPort 和 polarisToken"""
    if not MCP_CONFIG.exists():
        print(f"错误: 找不到 {MCP_CONFIG}")
        print("请确保 Polaris 应用正在运行")
        sys.exit(1)

    config = json.loads(MCP_CONFIG.read_text(encoding="utf-8"))
    # 从 polaris-browser 的 args 提取
    browser_server = config.get("mcpServers", {}).get("polaris-browser", {})
    args = browser_server.get("args", [])

    port = None
    token = None
    for i, arg in enumerate(args):
        if arg == "--polaris-port" and i + 1 < len(args):
            port = int(args[i + 1])
        if arg == "--polaris-token" and i + 1 < len(args):
            token = args[i + 1]

    if not port or not token:
        print("错误: 无法从 mcp.json 提取 port/token")
        sys.exit(1)

    return port, token


def write_frame(sock: socket.socket, value: dict) -> None:
    """发送 4字节小端长度 + JSON body(与 Rust write_frame 一致)"""
    body = json.dumps(value, ensure_ascii=False).encode("utf-8")
    length = len(body)
    sock.sendall(struct.pack("<I", length) + body)


def read_frame(sock: socket.socket) -> dict:
    """读取 4字节小端长度 + JSON body(与 Rust read_frame 一致)"""
    raw_len = sock.recv(4)
    if len(raw_len) < 4:
        raise ConnectionError("连接中断: 无法读取帧长度")
    length = struct.unpack("<I", raw_len)[0]
    if length == 0 or length > MAX_FRAME_SIZE:
        raise ValueError(f"非法帧长度: {length}")

    body = b""
    while len(body) < length:
        chunk = sock.recv(length - len(body))
        if not chunk:
            break
        body += chunk

    return json.loads(body.decode("utf-8"))


def call_browser(port: int, token: str, action: str, **args) -> dict:
    """
    模拟 browser_mcp_server.rs 的 TCP 请求。
    构造与 browser_frame() 一致的帧:
        {type, token, sessionId, callId, action, ...args}
    """
    frame = {
        "type": "browser",
        "token": token,
        "sessionId": "",
        "callId": f"test-{action}-{int(time.time() * 1000) % 100000}",
        "action": action,
    }
    # 透传所有参数(与 browser_frame 的白名单逻辑一致)
    for key in [
        "label", "url", "index", "text", "value", "includeScreenshot",
        "title", "mode", "agentKey", "activate", "condition", "ms",
        "timeoutMs", "x", "y", "amount", "keys", "elementText", "delayMs",
        "enabled", "region", "query", "caseSensitive", "scale", "limit",
    ]:
        if key in args:
            frame[key] = args[key]

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(30)
    sock.connect(("127.0.0.1", port))
    write_frame(sock, frame)
    response = read_frame(sock)
    sock.close()
    return response


def test_case(name: str, port: int, token: str, action: str, **args) -> bool:
    """执行单个测试用例，返回是否通过"""
    print(f"\n{'='*60}")
    print(f"测试: {name}")
    print(f"  action={action}, args={json.dumps(args, ensure_ascii=False)[:120]}")
    try:
        result = call_browser(port, token, action, **args)
        ok = result.get("ok", False)
        if ok:
            result_data = result.get("result", {})
            # 截断显示
            result_str = json.dumps(result_data, ensure_ascii=False)
            if len(result_str) > 300:
                result_str = result_str[:300] + "..."
            print(f"  [PASS] ok=true")
            print(f"  result={result_str}")
            return True
        else:
            error = result.get("error", "未知错误")
            print(f"  [FAIL] ok=false")
            print(f"  error={error}")
            return False
    except Exception as e:
        print(f"  [FAIL] 异常: {type(e).__name__}: {e}")
        return False


def main():
    print("=" * 60)
    print("Polaris 内置浏览器 MCP 协议直连验证")
    print("=" * 60)

    port, token = load_port_token()
    print(f"端口: {port}")
    print(f"Token: {token[:8]}...{token[-4:]}")

    # 先做连通性测试
    print(f"\n--- 连通性测试 ---")
    try:
        result = call_browser(port, token, "list")
        print(f"连通性: {'[PASS]' if result.get('ok') else '[FAIL]'}")
        if not result.get("ok"):
            print(f"错误: {result.get('error')}")
            print("请确保 Polaris 应用正在运行且内置浏览器已打开")
            return
        sessions = result.get("result", [])
        print(f"当前浏览器会话数: {len(sessions)}")
        for s in sessions:
            print(f"  - label={s.get('label')}, url={s.get('url', '')[:60]}")
    except Exception as e:
        print(f"连通性失败: {e}")
        print("请确保 Polaris 应用正在运行")
        return

    # 如果没有浏览器会话，尝试 acquire 一个
    has_session = len(sessions) > 0
    if not has_session:
        print(f"\n--- 无浏览器会话，尝试 acquire ---")
        result = test_case("acquire 新标签", port, token, "acquire",
                           url="https://example.com", title="Test")
        has_session = result

    if not has_session:
        print("\n无法获取浏览器会话，后续测试跳过")
        return

    # 逐个验证现有工具
    results = []
    results.append(test_case("navigate 导航", port, token, "navigate",
                            url="https://example.com"))
    results.append(test_case("context 页面上下文", port, token, "context"))
    results.append(test_case("inspect 可操作元素", port, token, "inspect"))
    results.append(test_case("diagnostics 诊断快照", port, token, "diagnostics",
                            includeScreenshot=False))
    results.append(test_case("history_state 历史状态", port, token, "history_state"))
    results.append(test_case("network_info 性能数据", port, token, "network_info"))
    results.append(test_case("network_requests 请求列表", port, token, "network_requests",
                            limit=10))
    results.append(test_case("status 页面状态", port, token, "status"))
    results.append(test_case("scroll 滚动到底部", port, token, "scroll", mode="bottom"))
    results.append(test_case("scroll 回到顶部", port, token, "scroll", mode="top"))
    results.append(test_case("find 查找文本", port, token, "find",
                            query="Example"))
    results.append(test_case("zoom 缩放", port, token, "zoom", scale=1.0))

    # 汇总
    print(f"\n{'='*60}")
    print(f"测试汇总: {sum(results)}/{len(results)} 通过")
    print(f"{'='*60}")

    if all(results):
        print("\n[PASS] 所有现有工具验证通过")
        print("   结论: TCP 直连 ask_listener 链路完全可用")
        print("   后续新增工具只需在 dispatch() 路由表加分支即可用同样方式测试")
    else:
        failed = [name for name, ok in zip(
            ["navigate", "context", "inspect", "diagnostics",
             "history_state", "network_info", "network_requests",
             "status", "scroll(bottom)", "scroll(top)", "find", "zoom"],
            results
        ) if not ok]
        print(f"\n[FAIL] 失败的测试: {failed}")


if __name__ == "__main__":
    main()
