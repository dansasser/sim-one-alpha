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


class GatewayHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
        REQUESTS.append(json.loads(body))
        response = b'{"result":{"text":"interactive smoke response"}}'
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

        os.write(master_fd, b"first line/\r")
        os.write(master_fd, b"\x1b[13;1:2u")
        time.sleep(0.5)
        if REQUESTS:
            raise AssertionError(
                f"slash-Enter repeat submitted prematurely: {REQUESTS!r}"
            )

        os.write(master_fd, b"second line\r")
        if wait_for_request_count(1, 5) != 1:
            raise AssertionError(f"completed multiline prompt was not submitted: {REQUESTS!r}")

        prompt = REQUESTS[0].get("text")
        if prompt != "first line\nsecond line":
            raise AssertionError(
                f"multiline prompt payload mismatch: expected 'first line\\nsecond line', got {prompt!r}"
            )

        print(
            "[ratatui-interactive] packaged sim-one preserved slash-Enter newline through an Enter repeat and submitted the exact multiline payload."
        )
    finally:
        stop_child(pid, master_fd)
        os.close(master_fd)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
