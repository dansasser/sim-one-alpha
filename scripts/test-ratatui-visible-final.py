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
LIVE_MARKER = b"LIVE_ASSISTANT_STREAM_MARKER"
CHILD_MARKER = b"CHILD_RAW_OUTPUT_MARKER"
FINAL_MARKER = b"FINAL_VISIBLE_MARKER"
FINAL_CONTINUATION_MARKER = b"FINAL_CONTINUATION_MARKER"
FINAL_TEXT = (
    f"**{FINAL_MARKER.decode()}**\n\n`{FINAL_CONTINUATION_MARKER.decode()}`"
)
LIVE_CONNECTED = threading.Event()
PROMPT_RECEIVED = threading.Event()
LIVE_DELTA_SENT = threading.Event()
ALLOW_FINAL = threading.Event()
SSE_SENT = threading.Event()
RELEASE_HTTP = threading.Event()
REQUEST_PATHS = []


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        REQUEST_PATHS.append(("GET", self.path))
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
            live_events = [
                {
                    "type": "text_delta",
                    "eventIndex": 50,
                    "timestamp": "2026-07-11T18:35:00Z",
                    "session": "task:default:worker-1",
                    "parentSession": "default",
                    "text": CHILD_MARKER.decode(),
                },
                {
                    "type": "message_end",
                    "eventIndex": 51,
                    "timestamp": "2026-07-11T18:35:01Z",
                    "session": "task:default:worker-1",
                    "parentSession": "default",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": CHILD_MARKER.decode()}],
                    },
                },
                {
                    "type": "text_delta",
                    "eventIndex": 5,
                    "timestamp": "2026-07-11T18:37:02Z",
                    "session": "default",
                    "text": LIVE_MARKER.decode(),
                },
            ]
            live_frame = f"event: data\ndata: {json.dumps(live_events)}\n\n".encode()
            self.wfile.write(live_frame)
            self.wfile.flush()
            LIVE_DELTA_SENT.set()
            if not ALLOW_FINAL.wait(5):
                return
            final_events = [
                {
                    "type": "message_end",
                    "eventIndex": 21,
                    "timestamp": "2026-07-11T18:37:09Z",
                    "session": "default",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": FINAL_TEXT}],
                    },
                },
                {"type": "turn", "eventIndex": 23, "isError": False},
                {
                    "type": "operation",
                    "eventIndex": 25,
                    "name": "operation",
                    "isError": False,
                },
            ]
            frame = f"event: data\ndata: {json.dumps(final_events)}\n\n".encode()
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
        REQUEST_PATHS.append(("POST", self.path))
        length = int(self.headers.get("Content-Length", "0"))
        self.rfile.read(length)
        if self.path == "/api/chat/sessions/tui-visible-final-smoke/resume":
            response = json.dumps(
                {
                    "session": {
                        "id": "tui-visible-final-smoke",
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
        PROMPT_RECEIVED.set()
        if not RELEASE_HTTP.wait(10):
            return
        response = json.dumps({"result": {"text": FINAL_TEXT}}).encode()
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
        startup_output = read_until(master_fd, b"Prompt", 10)
        if not LIVE_CONNECTED.wait(5):
            startup_output.extend(read_for(master_fd, 1.0))
            raise AssertionError(
                "packaged TUI did not attach its Flue live stream; "
                f"requests={REQUEST_PATHS!r}; output tail={bytes(startup_output[-3000:])!r}"
            )
        os.write(master_fd, b"show the final response\r")
        if not LIVE_DELTA_SENT.wait(5):
            raise AssertionError("mock gateway did not deliver the live assistant delta")
        live_output = read_until(master_fd, LIVE_MARKER, 5)
        if CHILD_MARKER in live_output:
            raise AssertionError(
                "packaged TUI exposed nested worker output as a chat response; "
                f"output tail={bytes(live_output[-3000:])!r}"
            )
        ALLOW_FINAL.set()
        if not SSE_SENT.wait(5):
            raise AssertionError("mock gateway did not deliver the final Flue event frame")
        output = read_until(master_fd, FINAL_CONTINUATION_MARKER, 5)
        visible_before_http = FINAL_MARKER in output and FINAL_CONTINUATION_MARKER in output
        if b"**FINAL_VISIBLE_MARKER**" in output or b"`FINAL_CONTINUATION_MARKER`" in output:
            raise AssertionError(
                "packaged TUI exposed Markdown source markers instead of styled content; "
                f"output tail={bytes(output[-3000:])!r}"
            )
        RELEASE_HTTP.set()
        output_after_http = read_for(master_fd, 1.0)
        if not visible_before_http:
            raise AssertionError(
                "packaged TUI did not render Flue's multiline final message before the HTTP request settled; "
                f"before-HTTP output tail={bytes(output[-3000:])!r}; "
                f"after-HTTP output tail={bytes(output_after_http[-1000:])!r}"
            )
        print(
            "[ratatui-visible-final] packaged sim-one kept nested worker output internal, rendered Markdown styles, rendered a live root assistant block, and consolidated Flue's multiline final before HTTP settled."
        )
    finally:
        RELEASE_HTTP.set()
        stop_child(pid, master_fd)
        os.close(master_fd)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
