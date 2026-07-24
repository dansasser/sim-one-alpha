#!/usr/bin/env python3

import base64
import json
import os
import re
import sys

if os.name != "posix":
    print("[ratatui-interactive] PTY smoke skipped on non-POSIX platform.")
    raise SystemExit(0)

import fcntl
import pty
import select
import signal
import struct
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent.parent
SIM_ONE = ROOT / ".gorombo" / "sim-one-cli" / "sim-one"
REQUESTS = []
REQUEST_PATHS = []
RESTORED_OLDEST_PROMPT = "RESTORED_OLDEST_PROMPT"
RESTORED_INITIAL_ANCHOR = "RESTORED_INITIAL_ANCHOR"
RESTORED_NEWEST_FINAL = "RESTORED_NEWEST_FINAL"
OLDER_PAGE_REQUESTED = threading.Event()
RELEASE_OLDER_PAGE = threading.Event()


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        REQUEST_PATHS.append(("GET", self.path))
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/chat/sessions/tui-interactive-smoke/transcript":
            before = query.get("before", [None])[0]
            if before is None:
                exchanges = [
                    transcript_exchange(
                        f"interactive-current-{index}",
                        RESTORED_INITIAL_ANCHOR if index == 0 else f"restored prompt {index:02d}",
                        RESTORED_NEWEST_FINAL
                        if index == 7
                        else f"restored final {index:02d}",
                    )
                    for index in range(8)
                ]
                page = {
                    "limit": 50,
                    "hasOlder": True,
                    "before": "interactive-older-page",
                }
            elif before == "interactive-older-page":
                OLDER_PAGE_REQUESTED.set()
                if not RELEASE_OLDER_PAGE.wait(5):
                    return
                exchanges = [
                    transcript_exchange(
                        "interactive-oldest",
                        RESTORED_OLDEST_PROMPT,
                        "RESTORED_OLDEST_FINAL",
                    )
                ]
                page = {"limit": 50, "hasOlder": False}
            else:
                self.send_response(400)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            response = json.dumps(
                {
                    "session": {
                        "id": "tui-interactive-smoke",
                        "title": "Interactive History Smoke",
                    },
                    "exchanges": exchanges,
                    "stream": {
                        "nextOffset": "0000000000000000_0000000000000042",
                        "upToDate": True,
                    },
                    "page": page,
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
            return

        if parsed.path == "/agents/orchestrator/tui-interactive-smoke":
            if query.get("live") == ["sse"]:
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                control = {
                    "streamNextOffset": "0000000000000000_0000000000000042",
                    "upToDate": True,
                }
                self.wfile.write(
                    f"event: control\ndata: {json.dumps(control)}\n\n".encode()
                )
                self.wfile.flush()
                time.sleep(0.2)
                return
            response = b"[]"
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.send_header(
                "stream-next-offset",
                "0000000000000000_0000000000000042",
            )
            self.send_header("stream-up-to-date", "true")
            self.end_headers()
            self.wfile.write(response)
            return

        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        REQUEST_PATHS.append(("POST", self.path))
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        if self.path == "/api/chat/sessions/tui-interactive-smoke/resume":
            response = json.dumps(
                {
                    "session": {
                        "id": "tui-interactive-smoke",
                        "surface": "tui",
                        "created": False,
                    }
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(response)))
            self.end_headers()
            self.wfile.write(response)
            return
        REQUESTS.append(json.loads(body))
        response_lines = [f"interactive smoke response {len(REQUESTS)}"]
        response_lines.extend(
            f"response detail {index:02d}" for index in range(1, 13)
        )
        response_lines.append(f"response-final-{len(REQUESTS)}")
        response = json.dumps(
            {
                "result": {
                    "text": "\n".join(response_lines)
                }
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format, *_args):
        return


def transcript_exchange(exchange_id, prompt, final):
    return {
        "id": exchange_id,
        "submissionId": exchange_id,
        "prompt": {
            "id": f"{exchange_id}:prompt",
            "text": prompt,
            "receivedAt": "2026-07-23T15:00:00.000Z",
            "visibility": "user",
        },
        "activities": [
            {
                "id": f"{exchange_id}:operation",
                "kind": "operation",
                "name": "prompt",
                "status": "completed",
                "durationMs": 25,
            }
        ],
        "assistant": {
            "id": f"{exchange_id}:assistant",
            "text": final,
            "completedAt": "2026-07-23T15:00:01.000Z",
        },
        "status": "completed",
    }


def read_until(master_fd, marker, timeout):
    output = bytearray()
    deadline = time.monotonic() + timeout
    while marker not in output and time.monotonic() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if not ready:
            continue
        try:
            output.extend(os.read(master_fd, 65536))
        except OSError:
            break
    if marker not in output:
        raise AssertionError(
            f"packaged TUI did not render {marker!r}; output tail={bytes(output[-2000:])!r}"
        )
    return output


def wait_for_request_count(expected, timeout):
    deadline = time.monotonic() + timeout
    while len(REQUESTS) < expected and time.monotonic() < deadline:
        time.sleep(0.02)
    return len(REQUESTS)


def wait_for_path(method, prefix, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(seen_method == method and path.startswith(prefix) for seen_method, path in REQUEST_PATHS):
            return True
        time.sleep(0.02)
    return False


def wait_for_path_with(method, prefix, fragment, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if any(
            seen_method == method
            and path.startswith(prefix)
            and fragment in path
            for seen_method, path in REQUEST_PATHS
        ):
            return True
        time.sleep(0.02)
    return False


def wait_for_diagnostic(path, event, timeout):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            entries = [
                json.loads(line)
                for line in path.read_text().splitlines()
                if line.strip()
            ]
        except (FileNotFoundError, json.JSONDecodeError):
            entries = []
        if any(entry.get("event") == event for entry in entries):
            return True
        time.sleep(0.02)
    return False


def drain_output(master_fd, duration=0.3):
    read_output(master_fd, duration)


def read_output(master_fd, duration=0.3):
    output = bytearray()
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.02)
        if not ready:
            continue
        try:
            output.extend(os.read(master_fd, 65536))
        except OSError:
            break
    return bytes(output)


def read_osc52(master_fd, timeout):
    output = bytearray()
    pattern = re.compile(rb"\x1b\]52;c;([A-Za-z0-9+/=]*)\x1b\\")
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        match = pattern.search(output)
        if match:
            return base64.b64decode(match.group(1)).decode("utf-8")
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if not ready:
            continue
        try:
            output.extend(os.read(master_fd, 65536))
        except OSError:
            break
    raise AssertionError(f"packaged TUI did not emit an OSC52 payload: {bytes(output[-2000:])!r}")


def find_copied_transcript_row(master_fd, marker):
    for row in range(2, 19):
        drag_mouse(master_fd, 4, row, 90, row)
        copied = read_osc52(master_fd, 1)
        if marker in copied:
            return row, copied
    raise AssertionError(f"visible transcript did not contain copied marker {marker!r}")


def send_mouse(master_fd, code, column, row, release=False):
    suffix = "m" if release else "M"
    os.write(master_fd, f"\x1b[<{code};{column};{row}{suffix}".encode())


def click_mouse(master_fd, column, row):
    send_mouse(master_fd, 0, column, row)
    send_mouse(master_fd, 0, column, row, release=True)


def drag_mouse(master_fd, start_column, start_row, end_column, end_row):
    send_mouse(master_fd, 0, start_column, start_row)
    send_mouse(master_fd, 32, end_column, end_row)
    send_mouse(master_fd, 0, end_column, end_row, release=True)


def stop_child(pid, master_fd):
    try:
        os.write(master_fd, b"\x03")
    except OSError:
        pass

    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        waited, _ = os.waitpid(pid, os.WNOHANG)
        if waited == pid:
            return
        time.sleep(0.05)

    os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)


def main():
    if not SIM_ONE.exists():
        raise AssertionError(f"{SIM_ONE} does not exist; run pnpm run build:all first")

    server = ThreadingHTTPServer(("127.0.0.1", 0), GatewayHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    port = server.server_address[1]
    diagnostics_directory = None
    configured_diagnostics = os.environ.get("SIM_ONE_TUI_LOG_PATH")
    if configured_diagnostics:
        diagnostics_path = Path(configured_diagnostics)
    else:
        diagnostics_directory = tempfile.TemporaryDirectory(
            prefix="ratatui-interactive-diagnostics-"
        )
        diagnostics_path = Path(diagnostics_directory.name) / "ratatui.jsonl"

    pid, master_fd = pty.fork()
    if pid == 0:
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
        env["SIM_ONE_TUI_LOG_PATH"] = str(diagnostics_path)
        env.pop("SIM_ONE_TUI_PATH", None)
        os.chdir(ROOT)
        os.execve(
            SIM_ONE,
            [
                str(SIM_ONE),
                "--base-url",
                f"http://127.0.0.1:{port}",
                "--session",
                "tui-interactive-smoke",
            ],
            env,
        )

    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 100, 0, 0))
        startup_output = read_until(
            master_fd,
            RESTORED_NEWEST_FINAL.encode(),
            10,
        )
        if RESTORED_INITIAL_ANCHOR.encode() in startup_output:
            raise AssertionError(
                "packaged TUI did not start at the true restored-history tail"
            )
        if not wait_for_path("GET", "/agents/orchestrator/tui-interactive-smoke", 5):
            raise AssertionError(
                f"packaged TUI did not validate resume and request its stream: {REQUEST_PATHS!r}"
            )

        for _ in range(5):
            os.write(master_fd, b"\x1b[5~")
            time.sleep(0.05)
        if not wait_for_path_with(
            "GET",
            "/api/chat/sessions/tui-interactive-smoke/transcript?",
            "before=interactive-older-page",
            5,
        ):
            raise AssertionError(
                f"packaged TUI did not request its older transcript page: {REQUEST_PATHS!r}"
            )
        if not OLDER_PAGE_REQUESTED.wait(5):
            raise AssertionError("older transcript fixture did not receive the page request")
        anchor_row, anchor_before = find_copied_transcript_row(
            master_fd,
            RESTORED_INITIAL_ANCHOR,
        )
        os.write(master_fd, b"\x03")
        if read_osc52(master_fd, 5) != anchor_before:
            raise AssertionError("Ctrl+C did not preserve the restored transcript selection")
        os.write(master_fd, b"\x1b")
        RELEASE_OLDER_PAGE.set()
        if not wait_for_diagnostic(
            diagnostics_path,
            "history.page.prepended",
            5,
        ):
            raise AssertionError(
                f"packaged TUI did not install the older page; diagnostics={diagnostics_path}"
            )
        drain_output(master_fd)
        click_mouse(master_fd, 100, 2)
        read_until(master_fd, RESTORED_OLDEST_PROMPT.encode(), 5)

        os.write(master_fd, b"scrollback-draft\r")
        if wait_for_request_count(1, 5) != 1:
            raise AssertionError(
                f"prompt submission was inactive during scrollback: {REQUESTS!r}"
            )
        if REQUESTS[0].get("text") != "scrollback-draft":
            raise AssertionError(
                f"scrollback prompt payload mismatch: {REQUESTS[0]!r}"
            )

        click_mouse(master_fd, 100, 18)
        read_until(master_fd, b"response-final-1", 5)

        os.write(master_fd, b"/res")
        read_until(master_fd, b"Resume a durable session", 5)
        os.write(master_fd, b"\t")
        time.sleep(0.2)
        if len(REQUESTS) != 1:
            raise AssertionError(
                f"command palette selection submitted prematurely: {REQUESTS!r}"
            )
        os.write(master_fd, b"\x15")

        os.write(master_fd, b"/")
        read_until(master_fd, b"Resume a durable session", 5)
        send_mouse(master_fd, 65, 5, 13)
        click_mouse(master_fd, 5, 15)
        read_until(master_fd, b"resume", 5)
        if len(REQUESTS) != 1:
            raise AssertionError(
                f"mouse command palette selection submitted prematurely: {REQUESTS!r}"
            )
        os.write(master_fd, b"\x15")

        os.write(master_fd, b"first line\\\r")
        os.write(master_fd, b"\x1b[13;1:2u")
        time.sleep(0.5)
        if len(REQUESTS) != 1:
            raise AssertionError(
                f"backslash-Enter repeat submitted prematurely: {REQUESTS!r}"
            )

        os.write(master_fd, b"second line")
        os.write(master_fd, b"\x1b[A")
        os.write(master_fd, b" updated")
        os.write(master_fd, b"\x1b[B")
        os.write(master_fd, b"\r")
        if wait_for_request_count(2, 5) != 2:
            raise AssertionError(f"completed multiline prompt was not submitted: {REQUESTS!r}")

        prompt = REQUESTS[1].get("text")
        if prompt != "first line updated\nsecond line":
            raise AssertionError(
                f"multiline prompt payload mismatch: expected 'first line updated\\nsecond line', got {prompt!r}"
            )
        read_until(master_fd, b"response-final-2", 5)

        os.write(master_fd, b"keep remove tail")
        drag_mouse(master_fd, 9, 22, 14, 22)
        read_until(master_fd, b"\x1b]52;c;cmVtb3Zl\x1b\\", 5)
        os.write(master_fd, b"X\r")
        if wait_for_request_count(3, 5) != 3:
            raise AssertionError(f"mouse-edited prompt was not submitted: {REQUESTS!r}")
        if REQUESTS[2].get("text") != "keep X tail":
            raise AssertionError(
                f"mouse selection replacement payload mismatch: {REQUESTS[2]!r}"
            )
        read_until(master_fd, b"response-final-3", 5)

        os.write(master_fd, b"mouse alpha bravo")
        click_mouse(master_fd, 16, 22)
        os.write(master_fd, b"X\r")
        if wait_for_request_count(4, 5) != 4:
            raise AssertionError(f"mouse-click-edited prompt was not submitted: {REQUESTS!r}")
        if REQUESTS[3].get("text") != "mouse alpha Xbravo":
            raise AssertionError(
                f"mouse cursor placement payload mismatch: {REQUESTS[3]!r}"
            )
        read_until(master_fd, b"response-final-4", 5)

        for line in (b"alpha", b"bravo", b"charlie", b"delta", b"echo", b"foxtrot"):
            os.write(master_fd, line + b"\\\r")
        os.write(master_fd, b"golf")
        drain_output(master_fd)
        send_mouse(master_fd, 64, 10, 20)
        read_until(master_fd, b"charlie", 5)
        os.write(master_fd, b"\x15")

        drain_output(master_fd)
        click_mouse(master_fd, 100, 2)
        top_redraw = read_output(master_fd, 0.5)
        if RESTORED_OLDEST_PROMPT.encode() not in top_redraw:
            raise AssertionError(
                f"scrollbar top click did not reveal the oldest restored prompt: {top_redraw!r}"
            )
        drain_output(master_fd)
        click_mouse(master_fd, 100, 18)
        tail_redraw = read_output(master_fd, 0.5)
        if b"response-fina" not in tail_redraw or b"-4" not in tail_redraw:
            raise AssertionError(
                f"scrollbar bottom click did not reveal the latest response: {tail_redraw!r}"
            )

        print(
            "[ratatui-interactive] packaged sim-one loaded paged history at the true tail, preserved the prepend anchor, kept prompt editing active during scrollback, copied restored text without exit, returned to live tail, and preserved keyboard/mouse prompt controls."
        )
    finally:
        RELEASE_OLDER_PAGE.set()
        stop_child(pid, master_fd)
        os.close(master_fd)
        server.shutdown()
        server.server_close()
        if diagnostics_directory is not None:
            diagnostics_directory.cleanup()


if __name__ == "__main__":
    main()
