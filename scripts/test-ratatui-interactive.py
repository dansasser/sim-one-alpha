#!/usr/bin/env python3

import json
import os
import sys

if os.name != "posix":
    print("[ratatui-interactive] PTY smoke skipped on non-POSIX platform.")
    raise SystemExit(0)

import fcntl
import pty
import select
import signal
import struct
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SIM_ONE = ROOT / ".gorombo" / "sim-one-cli" / "sim-one"
REQUESTS = []
REQUEST_PATHS = []


class GatewayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        REQUEST_PATHS.append(("GET", self.path))
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

    pid, master_fd = pty.fork()
    if pid == 0:
        env = os.environ.copy()
        env["TERM"] = "xterm-256color"
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
        read_until(master_fd, b"Prompt", 10)
        if not wait_for_path("GET", "/agents/orchestrator/tui-interactive-smoke", 5):
            raise AssertionError(
                f"packaged TUI did not validate resume and request its stream: {REQUEST_PATHS!r}"
            )

        os.write(master_fd, b"/res")
        read_until(master_fd, b"Resume a durable session", 5)
        os.write(master_fd, b"\t")
        time.sleep(0.2)
        if REQUESTS:
            raise AssertionError(
                f"command palette selection submitted prematurely: {REQUESTS!r}"
            )
        os.write(master_fd, b"\x15")

        os.write(master_fd, b"/")
        read_until(master_fd, b"Resume a durable session", 5)
        send_mouse(master_fd, 65, 5, 13)
        click_mouse(master_fd, 5, 15)
        read_until(master_fd, b"resume", 5)
        if REQUESTS:
            raise AssertionError(
                f"mouse command palette selection submitted prematurely: {REQUESTS!r}"
            )
        os.write(master_fd, b"\x15")

        os.write(master_fd, b"first line\\\r")
        os.write(master_fd, b"\x1b[13;1:2u")
        time.sleep(0.5)
        if REQUESTS:
            raise AssertionError(
                f"backslash-Enter repeat submitted prematurely: {REQUESTS!r}"
            )

        os.write(master_fd, b"second line")
        os.write(master_fd, b"\x1b[A")
        os.write(master_fd, b" updated")
        os.write(master_fd, b"\x1b[B")
        os.write(master_fd, b"\r")
        if wait_for_request_count(1, 5) != 1:
            raise AssertionError(f"completed multiline prompt was not submitted: {REQUESTS!r}")

        prompt = REQUESTS[0].get("text")
        if prompt != "first line updated\nsecond line":
            raise AssertionError(
                f"multiline prompt payload mismatch: expected 'first line updated\\nsecond line', got {prompt!r}"
            )
        read_until(master_fd, b"response-final-1", 5)

        os.write(master_fd, b"keep remove tail")
        drag_mouse(master_fd, 9, 22, 14, 22)
        read_until(master_fd, b"\x1b]52;c;cmVtb3Zl\x1b\\", 5)
        os.write(master_fd, b"X\r")
        if wait_for_request_count(2, 5) != 2:
            raise AssertionError(f"mouse-edited prompt was not submitted: {REQUESTS!r}")
        if REQUESTS[1].get("text") != "keep X tail":
            raise AssertionError(
                f"mouse selection replacement payload mismatch: {REQUESTS[1]!r}"
            )
        read_until(master_fd, b"response-final-2", 5)

        os.write(master_fd, b"mouse alpha bravo")
        click_mouse(master_fd, 16, 22)
        os.write(master_fd, b"X\r")
        if wait_for_request_count(3, 5) != 3:
            raise AssertionError(f"mouse-click-edited prompt was not submitted: {REQUESTS!r}")
        if REQUESTS[2].get("text") != "mouse alpha Xbravo":
            raise AssertionError(
                f"mouse cursor placement payload mismatch: {REQUESTS[2]!r}"
            )
        read_until(master_fd, b"response-final-3", 5)

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
        if b"preflight" not in top_redraw and b"system" not in top_redraw:
            raise AssertionError(
                f"scrollbar top click did not reveal startup rows: {top_redraw!r}"
            )
        drain_output(master_fd)
        click_mouse(master_fd, 100, 18)
        tail_redraw = read_output(master_fd, 0.5)
        if b"response-fina" not in tail_redraw or b"-3" not in tail_redraw:
            raise AssertionError(
                f"scrollbar bottom click did not reveal the latest response: {tail_redraw!r}"
            )

        print(
            "[ratatui-interactive] packaged sim-one handled keyboard and mouse palette selection, multiline editing, prompt drag-copy/replacement, click cursor placement, prompt-local wheel scrolling, and full-range scrollbar navigation with exact submitted payloads."
        )
    finally:
        stop_child(pid, master_fd)
        os.close(master_fd)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
