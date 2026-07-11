#!/usr/bin/env python3

import json
import os
import sys

if os.name != "posix":
    print("[ratatui-visible-final] PTY smoke skipped on non-POSIX platform.")
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
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent.parent
SIM_ONE = ROOT / ".gorombo" / "sim-one-cli" / "sim-one"
FINAL_MARKER = b"FINAL_VISIBLE_MARKER"
LIVE_CONNECTED = threading.Event()
PROMPT_RECEIVED = threading.Event()
SSE_SENT = threading.Event()
RELEASE_HTTP = threading.Event()


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urlparse(self.path)
        if not parsed.path.startswith("/agents/orchestrator/"):
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if parse_qs(parsed.query).get("live") == ["sse"]:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.end_headers()
            LIVE_CONNECTED.set()
            if not PROMPT_RECEIVED.wait(5):
                return
            events = [
                {
                    "type": "message_end",
                    "eventIndex": 200,
                    "role": "assistant",
                    "text": FINAL_MARKER.decode(),
                },
                {"type": "turn", "eventIndex": 201, "isError": False},
                {
                    "type": "operation",
                    "eventIndex": 202,
                    "name": "operation",
                    "isError": False,
                },
            ]
            frame = f"event: data\ndata: {json.dumps(events)}\n\n".encode()
            self.wfile.write(frame)
            self.wfile.flush()
            SSE_SENT.set()
            RELEASE_HTTP.wait(5)
            return

        history = [
            {"type": "log", "eventIndex": 100 + index, "text": f"history row {index}"}
            for index in range(24)
        ]
        body = json.dumps(history).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("stream-next-offset", "now")
        self.send_header("stream-up-to-date", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        PROMPT_RECEIVED.set()
        if not RELEASE_HTTP.wait(10):
            return
        response = json.dumps({"result": {"text": FINAL_MARKER.decode()}}).encode()
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


def read_for(master_fd, duration):
    output = bytearray()
    deadline = time.monotonic() + duration
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if not ready:
            continue
        try:
            output.extend(os.read(master_fd, 65536))
        except OSError:
            break
    return output


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
    threading.Thread(target=server.serve_forever, daemon=True).start()
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
                "tui-visible-final-smoke",
            ],
            env,
        )

    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", 35, 133, 0, 0))
        read_until(master_fd, b"Prompt", 10)
        if not LIVE_CONNECTED.wait(5):
            raise AssertionError("packaged TUI did not attach its Flue live stream")
        os.write(master_fd, b"show the final response\r")
        if not SSE_SENT.wait(5):
            raise AssertionError("mock gateway did not deliver the final Flue event frame")
        output = read_for(master_fd, 1.5)
        visible_before_http = FINAL_MARKER in output
        RELEASE_HTTP.set()
        output_after_http = read_until(master_fd, FINAL_MARKER, 5)
        if not visible_before_http:
            raise AssertionError(
                "packaged TUI did not render Flue's final message before the HTTP request settled; "
                "the same final marker appeared immediately after the HTTP response was released; "
                f"before-HTTP output tail={bytes(output[-3000:])!r}; "
                f"after-HTTP output tail={bytes(output_after_http[-1000:])!r}"
            )
        print(
            "[ratatui-visible-final] packaged sim-one rendered Flue's final message before the HTTP request settled."
        )
    finally:
        RELEASE_HTTP.set()
        stop_child(pid, master_fd)
        os.close(master_fd)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
