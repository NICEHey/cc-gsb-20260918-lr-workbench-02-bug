"""LR 文法冲突定位与逐符号分析工作台 —— 标准库 HTTP 服务器。

用法:
    python3 server.py                      # 127.0.0.1:8080
    python3 server.py --host 0.0.0.0 --port 8000

仅依赖 Python 标准库, 不使用第三方包、CDN 或外部服务, 不保存业务数据。

API:
    GET  /                        前端页面
    GET  /fixtures/grammars.json  样例文法
    POST /api/validate  {grammar}                        -> {valid, errors, warnings, clean}
    POST /api/build     {grammar, mode}                  -> 分析表(含冲突也正常返回)
    POST /api/parse     {grammar, mode, input}           -> 逐步分析轨迹
"""

from __future__ import annotations

import argparse
import json
import os
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import lr_core

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.css": ("app.css", "text/css; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/core.js": ("core.js", "text/javascript; charset=utf-8"),
}
MAX_BODY = 4 * 1024 * 1024  # 4 MiB, 远超 40 条产生式的草稿体积


class Handler(BaseHTTPRequestHandler):
    server_version = "LRWorkbench/1.0"

    # -- 工具 --
    def _send_json(self, payload, status=HTTPStatus.OK):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_error_json(self, message, status=HTTPStatus.BAD_REQUEST):
        self._send_json({"error": message}, status)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            raise ValueError("请求体为空")
        if length > MAX_BODY:
            raise ValueError("请求体超过 4 MiB 上限")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(f"JSON 解析失败: {exc}") from exc
        if not isinstance(data, dict):
            raise ValueError("请求体必须是 JSON 对象")
        return data

    def log_message(self, fmt, *args):  # 简洁日志
        peername = self.client_address[0] if self.client_address else "-"
        print(f"[{self.log_date_time_string()}] {peername} {fmt % args}")

    # -- 路由: GET --
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in STATIC:
            self._serve_file(*STATIC[path])
            return
        if path == "/fixtures/grammars.json":
            self._serve_file(os.path.join("fixtures", "grammars.json"),
                             "application/json; charset=utf-8")
            return
        if path == "/fixtures/format.md":
            self._serve_file(os.path.join("fixtures", "format.md"),
                             "text/markdown; charset=utf-8")
            return
        self._send_error_json("未找到资源", HTTPStatus.NOT_FOUND)

    def _serve_file(self, rel_path, content_type):
        full = os.path.normpath(os.path.join(BASE_DIR, rel_path))
        if not full.startswith(BASE_DIR + os.sep) and full != os.path.join(BASE_DIR, rel_path):
            self._send_error_json("非法路径", HTTPStatus.BAD_REQUEST)
            return
        try:
            with open(full, "rb") as fh:
                body = fh.read()
        except OSError:
            self._send_error_json("文件不存在", HTTPStatus.NOT_FOUND)
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    # -- 路由: POST --
    def do_POST(self):
        try:
            data = self._read_json()
        except ValueError as exc:
            self._send_error_json(str(exc))
            return

        if self.path == "/api/validate":
            self._api_validate(data)
        elif self.path == "/api/build":
            self._api_build(data)
        elif self.path == "/api/parse":
            self._api_parse(data)
        else:
            self._send_error_json("未知接口", HTTPStatus.NOT_FOUND)

    def _grammar_from_request(self, data):
        if "grammar" not in data:
            raise ValueError("缺少 grammar 字段")
        return data["grammar"]

    def _api_validate(self, data):
        try:
            draft = self._grammar_from_request(data)
            clean, errors, warnings = lr_core.validate_grammar(draft)
        except ValueError as exc:
            self._send_error_json(str(exc))
            return
        self._send_json({"valid": not errors, "errors": errors,
                         "warnings": warnings, "clean": clean})

    def _api_build(self, data):
        try:
            draft = self._grammar_from_request(data)
            mode = data.get("mode", lr_core.MODE_SLR)
            if mode not in lr_core.MODES:
                raise ValueError(f"mode 必须是 SLR 或 LR1, 收到 {mode!r}")
            table = lr_core.build_table(draft, mode)
        except (ValueError, lr_core.GrammarError) as exc:
            # 校验失败/超限: 返回明确错误, 不返回截断"成功"表
            self._send_error_json(str(exc))
            return
        payload = lr_core.public_table(table)
        payload["warnings"] = table.get("_warnings", [])
        self._send_json(payload)

    def _api_parse(self, data):
        try:
            draft = self._grammar_from_request(data)
            mode = data.get("mode", lr_core.MODE_SLR)
            text = data.get("input", "")
            if not isinstance(text, str):
                raise ValueError("input 必须是字符串")
            table = lr_core.build_table(draft, mode)
            result = lr_core.parse(table, text)
        except (ValueError, lr_core.GrammarError) as exc:
            self._send_error_json(str(exc))
            return
        self._send_json(result)


def main():
    ap = argparse.ArgumentParser(description="LR 文法分析工作台")
    ap.add_argument("--host", default="127.0.0.1", help="监听地址, 默认 127.0.0.1")
    ap.add_argument("--port", type=int, default=8080, help="监听端口, 默认 8080")
    args = ap.parse_args()

    if not (1 <= args.port <= 65535):
        ap.error("端口须在 1~65535 之间")

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    url_host = args.host if args.host not in ("0.0.0.0", "::") else "127.0.0.1"
    print(f"LR 文法分析工作台已启动: http://{url_host}:{args.port}/", flush=True)
    print("按 Ctrl+C 停止。", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n正在关闭…")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
