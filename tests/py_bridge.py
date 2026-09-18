"""测试桥: 让 node 页面测试拿到与 server.py 完全一致的真实后端结果。

stdin 一行/整段 JSON: {"endpoint": "validate|build|parse", "payload": {...}}
stdout JSON:
  成功: {"ok": true, "data": <与 HTTP 200 相同的 JSON>}
  失败: {"ok": false, "error": "<message>"}
响应时机与顺序由 node 端的 fetch 桩控制, 本桥只负责同步计算真实结果。
"""

import json
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import lr_core as L  # noqa: E402


def main():
    req = json.loads(sys.stdin.read())
    endpoint = req["endpoint"]
    payload = req.get("payload") or {}
    try:
        if endpoint == "validate":
            clean, errors, warnings = L.validate_grammar(payload.get("grammar"))
            data = {"valid": not errors, "errors": errors,
                    "warnings": warnings, "clean": clean}
        elif endpoint == "build":
            table = L.build_table(payload.get("grammar"),
                                  payload.get("mode", L.MODE_SLR))
            data = L.public_table(table)
            data["warnings"] = table.get("_warnings", [])
        elif endpoint == "parse":
            table = L.build_table(payload.get("grammar"),
                                  payload.get("mode", L.MODE_SLR))
            data = L.parse(table, payload.get("input", ""))
        else:
            raise ValueError(f"未知端点 {endpoint!r}")
    except (ValueError, L.GrammarError) as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False))


if __name__ == "__main__":
    main()
