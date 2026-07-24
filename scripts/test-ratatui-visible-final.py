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
HISTORY_PROMPT_MARKER = b"HISTORY_VISIBLE_PROMPT"
HISTORY_FINAL_MARKER = b"HISTORY_AUTHORITATIVE_FINAL"
STALE_HISTORY_FINAL_MARKER = b"STALE_HISTORY_REPLAY_FINAL"
FINAL_TEXT = (
    f"**{FINAL_MARKER.decode()}**\n\n`{FINAL_CONTINUATION_MARKER.decode()}`"
)
OLD_SUBMISSION = "history-submission"
NEW_SUBMISSION = "race-submission"
HISTORY_OFFSET = "0000000000000000_0000000000000010"
STALE_REPLAY_OFFSET = "0000000000000000_0000000000000011"
IN_FLIGHT_OFFSET = "0000000000000000_0000000000000013"
FINAL_OFFSET = "0000000000000000_0000000000000016"
HISTORY_REQUESTED = threading.Event()
RESUME_COMPLETED = threading.Event()
RELEASE_HISTORY = threading.Event()
LIVE_CONNECTED = threading.Event()
PROMPT_RECEIVED = threading.Event()
LIVE_DELTA_SENT = threading.Event()
SSE_SENT = threading.Event()
RELEASE_HTTP = threading.Event()
REQUEST_PATHS = []
CATCH_UP_OFFSETS = []
LIVE_OFFSETS = []
LIVE_CONNECTION_COUNT = 0
STATE_LOCK = threading.Lock()
PTY_OUTPUT = bytearray()


class GatewayHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        REQUEST_PATHS.append(("GET", self.path))
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        if parsed.path == "/api/chat/sessions/tui-visible-final-smoke/transcript":
            HISTORY_REQUESTED.set()
            if not RELEASE_HISTORY.wait(5):
                return
            body = json.dumps(
                {
                    "session": {
                        "id": "tui-visible-final-smoke",
                        "title": "Race Resume Smoke",
                    },
                    "exchanges": [
                        {
                            "id": OLD_SUBMISSION,
                            "submissionId": OLD_SUBMISSION,
                            "prompt": {
                                "id": f"{OLD_SUBMISSION}:prompt",
                                "text": HISTORY_PROMPT_MARKER.decode(),
                                "receivedAt": "2026-07-23T16:00:00.000Z",
                                "visibility": "user",
                            },
                            "activities": [
                                {
                                    "id": f"{OLD_SUBMISSION}:operation",
                                    "kind": "operation",
                                    "name": "prompt",
                                    "status": "completed",
                                    "durationMs": 900,
                                }
                            ],
                            "assistant": {
                                "id": f"{OLD_SUBMISSION}:assistant",
                                "text": HISTORY_FINAL_MARKER.decode(),
                                "completedAt": "2026-07-23T16:00:01.000Z",
                            },
                            "status": "completed",
                        }
                    ],
                    "stream": {
                        "nextOffset": HISTORY_OFFSET,
                        "upToDate": True,
                    },
                    "page": {
                        "limit": 50,
                        "hasOlder": False,
                    },
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        if parsed.path != "/agents/orchestrator/tui-visible-final-smoke":
            self.send_response(404)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        offset = query.get("offset", ["-1"])[0]
        if query.get("live") == ["sse"]:
            global LIVE_CONNECTION_COUNT
            with STATE_LOCK:
                LIVE_CONNECTION_COUNT += 1
                connection_number = LIVE_CONNECTION_COUNT
                LIVE_OFFSETS.append(offset)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            LIVE_CONNECTED.set()
            if connection_number == 1:
                self.write_sse_data(live_in_flight_events())
                self.write_sse_control(IN_FLIGHT_OFFSET)
                LIVE_DELTA_SENT.set()
            else:
                self.write_sse_data(
                    [
                        *live_in_flight_events(),
                        {
                            "type": "message_end",
                            "submissionId": NEW_SUBMISSION,
                            "eventIndex": 3,
                            "timestamp": "2026-07-23T16:01:01.000Z",
                            "session": "default",
                            "message": {
                                "role": "assistant",
                                "content": [{"type": "text", "text": FINAL_TEXT}],
                            },
                        },
                        {
                            "type": "operation",
                            "submissionId": NEW_SUBMISSION,
                            "operationId": "race-operation",
                            "operationKind": "prompt",
                            "eventIndex": 4,
                            "durationMs": 1_500,
                            "isError": False,
                            "timestamp": "2026-07-23T16:01:01.100Z",
                        },
                    ]
                )
                self.write_sse_control(FINAL_OFFSET)
                SSE_SENT.set()
                RELEASE_HTTP.wait(5)
            self.close_connection = True
            return

        CATCH_UP_OFFSETS.append(offset)
        if offset == HISTORY_OFFSET:
            if not PROMPT_RECEIVED.wait(5):
                return
            events = [
                {
                    "type": "message_end",
                    "submissionId": OLD_SUBMISSION,
                    "eventIndex": 99,
                    "timestamp": "2026-07-23T16:00:01.500Z",
                    "session": "default",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "text",
                                "text": STALE_HISTORY_FINAL_MARKER.decode(),
                            }
                        ],
                    },
                }
            ]
            next_offset = STALE_REPLAY_OFFSET
        elif offset == IN_FLIGHT_OFFSET:
            events = live_in_flight_events()
            next_offset = IN_FLIGHT_OFFSET
        else:
            events = []
            next_offset = offset
        body = json.dumps(events).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("stream-next-offset", next_offset)
        self.send_header("stream-up-to-date", "true")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        REQUEST_PATHS.append(("POST", self.path))
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length)
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
            self.wfile.flush()
            RESUME_COMPLETED.set()
            return
        payload = json.loads(body)
        if payload.get("text") != "race prompt":
            raise AssertionError(f"unexpected race prompt payload: {payload!r}")
        PROMPT_RECEIVED.set()
        if not RELEASE_HTTP.wait(10):
            return
        response = json.dumps(
            {
                "result": {"text": FINAL_TEXT},
                "submissionId": NEW_SUBMISSION,
                "offset": FINAL_OFFSET,
            }
        ).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(response)))
        self.end_headers()
        self.wfile.write(response)

    def log_message(self, _format, *_args):
        return

    def write_sse_data(self, events):
        self.wfile.write(
            f"event: data\ndata: {json.dumps(events)}\n\n".encode()
        )
        self.wfile.flush()

    def write_sse_control(self, offset):
        control = {
            "streamNextOffset": offset,
            "upToDate": True,
            "streamClosed": False,
        }
        self.wfile.write(
            f"event: control\ndata: {json.dumps(control)}\n\n".encode()
        )
        self.wfile.flush()


def live_in_flight_events():
    return [
        {
            "type": "operation_start",
            "submissionId": NEW_SUBMISSION,
            "operationId": "race-operation",
            "operationKind": "prompt",
            "eventIndex": 0,
            "timestamp": "2026-07-23T16:01:00.100Z",
        },
        {
            "type": "text_delta",
            "submissionId": NEW_SUBMISSION,
            "eventIndex": 1,
            "timestamp": "2026-07-23T16:01:00.200Z",
            "session": "default",
            "text": LIVE_MARKER.decode(),
        },
        {
            "type": "text_delta",
            "submissionId": NEW_SUBMISSION,
            "eventIndex": 2,
            "timestamp": "2026-07-23T16:01:00.300Z",
            "session": "task:default:worker-1",
            "parentSession": "default",
            "text": CHILD_MARKER.decode(),
        },
    ]


def read_until(master_fd, marker, timeout):
    deadline = time.monotonic() + timeout
    while marker not in PTY_OUTPUT and time.monotonic() < deadline:
        ready, _, _ = select.select([master_fd], [], [], 0.1)
        if not ready:
            continue
        try:
            PTY_OUTPUT.extend(os.read(master_fd, 65536))
        except OSError:
            break
    if marker not in PTY_OUTPUT:
        raise AssertionError(
            f"packaged TUI did not render {marker!r}; output tail={bytes(PTY_OUTPUT[-2000:])!r}"
        )
    return bytes(PTY_OUTPUT)


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
        if not HISTORY_REQUESTED.wait(5):
            raise AssertionError(
                "packaged TUI did not request transcript history; "
                f"requests={REQUEST_PATHS!r}; output tail={bytes(startup_output[-3000:])!r}"
            )
        if not RESUME_COMPLETED.wait(5):
            raise AssertionError(
                "packaged TUI requested transcript history before session resume completed; "
                f"requests={REQUEST_PATHS!r}"
            )
        if (
            "POST",
            "/api/chat/sessions/tui-visible-final-smoke/resume",
        ) not in REQUEST_PATHS:
            raise AssertionError(
                "packaged TUI did not POST the explicit session resume before history"
            )
        os.write(master_fd, b"race prompt\r")
        time.sleep(0.3)
        if PROMPT_RECEIVED.is_set():
            raise AssertionError("packaged TUI submitted a prompt before history finished")

        RELEASE_HISTORY.set()
        history_output = read_until(master_fd, HISTORY_FINAL_MARKER, 5)
        if HISTORY_PROMPT_MARKER not in history_output:
            raise AssertionError(
                "packaged TUI history snapshot omitted its visible prompt"
            )
        os.write(master_fd, b"\r")
        if not LIVE_CONNECTED.wait(5):
            raise AssertionError(
                "packaged TUI did not attach its Flue stream after history; "
                f"requests={REQUEST_PATHS!r}"
            )

        if not LIVE_DELTA_SENT.wait(5):
            raise AssertionError(
                "mock gateway did not deliver the live assistant delta after stale replay"
            )
        live_output = read_until(master_fd, LIVE_MARKER, 5)
        if STALE_HISTORY_FINAL_MARKER in live_output:
            raise AssertionError(
                "packaged TUI replaced the authoritative history final with a stale replay"
            )
        if CHILD_MARKER in live_output:
            raise AssertionError(
                "packaged TUI exposed nested worker output as a chat response; "
                f"output tail={bytes(live_output[-3000:])!r}"
            )
        if not SSE_SENT.wait(5):
            raise AssertionError(
                "packaged TUI did not reconnect for the final Flue event frame"
            )
        output = read_until(master_fd, FINAL_CONTINUATION_MARKER, 5)
        visible_before_http = FINAL_MARKER in output and FINAL_CONTINUATION_MARKER in output
        if STALE_HISTORY_FINAL_MARKER in output:
            raise AssertionError(
                "packaged TUI exposed the stale replay after stream reconnect"
            )
        if b"**FINAL_VISIBLE_MARKER**" in output or b"`FINAL_CONTINUATION_MARKER`" in output:
            raise AssertionError(
                "packaged TUI exposed Markdown source markers instead of styled content; "
                f"output tail={bytes(output[-3000:])!r}"
            )
        if CATCH_UP_OFFSETS[:2] != [HISTORY_OFFSET, IN_FLIGHT_OFFSET]:
            raise AssertionError(
                "packaged TUI did not reconnect catch-up from confirmed offsets: "
                f"{CATCH_UP_OFFSETS!r}"
            )
        if LIVE_OFFSETS[:2] != [STALE_REPLAY_OFFSET, IN_FLIGHT_OFFSET]:
            raise AssertionError(
                "packaged TUI did not resume SSE from confirmed offsets: "
                f"{LIVE_OFFSETS!r}"
            )
        RELEASE_HTTP.set()
        output_after_http = read_for(master_fd, 1.0)
        if STALE_HISTORY_FINAL_MARKER in output_after_http:
            raise AssertionError(
                "HTTP reconciliation exposed the stale history final"
            )
        if not visible_before_http:
            raise AssertionError(
                "packaged TUI did not render Flue's multiline final message before the HTTP request settled; "
                f"before-HTTP output tail={bytes(output[-3000:])!r}; "
                f"after-HTTP output tail={bytes(output_after_http[-1000:])!r}"
            )
        print(
            "[ratatui-visible-final] packaged sim-one locked input through history, rejected stale replay settlement, reconnected from confirmed offsets, deduplicated the in-flight batch, hid nested output, rendered Markdown, and showed the final before HTTP settlement."
        )
    finally:
        RELEASE_HISTORY.set()
        RELEASE_HTTP.set()
        stop_child(pid, master_fd)
        os.close(master_fd)
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
