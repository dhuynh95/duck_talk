#!/usr/bin/env python3
"""
The local voice: Kokoro-82M behind one HTTP endpoint, for the relay to call a sentence at a time.

    POST /v1/audio/speech   {"input": "...", "voice": "af_heart", "speed": 1.0, "response_format": "pcm"}
                            -> 24 kHz, 16-bit, mono, little-endian PCM — what the page plays as it stands
    GET  /health            -> {"ok": true, "voices": N}, once the model is loaded and has said a word

The request is the OpenAI speech shape on purpose, so anything that speaks it can stand in for this.
It listens on 127.0.0.1 only, and refuses a Host header that is not that machine (DNS rebinding:
a web page cannot reach this by pointing its own name at 127.0.0.1).

Started by the relay (`server/kokoro.ts`) with `--parent <its pid>`, and gone when that process is.
Run by hand:  venv/bin/python server.py --models ~/.local/share/duck-talk/kokoro/models
"""

import argparse
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
import onnxruntime as ort
from kokoro_onnx import Kokoro

RATE = 24_000
MAX_BODY = 64 * 1024
MAX_TEXT = 4_000
# The first letter of a Kokoro voice names its language: af_heart is American English, bf_emma British.
LANG = {"a": "en-us", "b": "en-gb", "e": "es", "f": "fr-fr", "h": "hi", "i": "it", "j": "ja", "p": "pt-br", "z": "cmn"}
LOCAL_HOSTS = {"127.0.0.1", "localhost", "[::1]"}

kokoro: Kokoro
default_voice = "af_heart"
# One request at a time: the relay asks serially anyway, and one model on a few CPU threads is
# faster than several fighting over them.
lock = threading.Lock()


def say(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class Handler(BaseHTTPRequestHandler):
    server_version = "duck-talk-kokoro"

    def log_message(self, format, *args):  # noqa: A002 — the base class's name
        pass  # one line per sentence would drown the relay's own log

    def _local(self) -> bool:
        host = self.headers.get("Host") or ""
        name = host.split("]")[0] + "]" if host.startswith("[") else host.split(":")[0]
        return name in LOCAL_HOSTS

    def _send(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status: int, value) -> None:
        self._send(status, json.dumps(value).encode(), "application/json")

    def do_GET(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "not a local request"})
        if self.path == "/health":
            return self._json(200, {"ok": True, "voices": len(kokoro.get_voices())})
        self._json(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        if not self._local():
            return self._json(403, {"error": "not a local request"})
        if self.path != "/v1/audio/speech":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length <= 0 or length > MAX_BODY:
                return self._json(413, {"error": "body missing or too large"})
            body = json.loads(self.rfile.read(length))
            text = body.get("input")
            voice = body.get("voice") or default_voice
            speed = float(body.get("speed") or 1.0)
            if not isinstance(text, str) or not text.strip():
                return self._json(400, {"error": "input must be some text"})
            if len(text) > MAX_TEXT:
                return self._json(413, {"error": f"input is over {MAX_TEXT} characters"})
            if body.get("response_format", "pcm") != "pcm":
                return self._json(400, {"error": 'only "response_format": "pcm" is served'})
            if voice not in kokoro.get_voices():
                return self._json(400, {"error": f"no voice called {voice!r}"})
            speed = min(2.0, max(0.5, speed))
        except (ValueError, TypeError, json.JSONDecodeError) as e:
            return self._json(400, {"error": f"bad request: {e}"})
        started = time.monotonic()
        with lock:
            samples, rate = kokoro.create(text.strip(), voice=voice, speed=speed, lang=LANG.get(voice[:1], "en-us"))
        if rate != RATE:
            return self._json(500, {"error": f"model produced {rate} Hz, not {RATE}"})
        pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
        if os.environ.get("DEBUG"):
            say(f"{len(pcm) / 48_000:.1f}s of speech in {time.monotonic() - started:.2f}s: {text[:40]}")
        self._send(200, pcm, "audio/pcm")


def watch_parent(pid: int) -> None:
    """Exit when the relay that started this does, even if it was killed without a chance to say so."""
    while True:
        time.sleep(2)
        if os.getppid() != pid:
            os._exit(0)


def main() -> None:
    global kokoro, default_voice
    ap = argparse.ArgumentParser(description="Kokoro-82M as a local speech endpoint")
    ap.add_argument("--models", required=True, help="the folder holding kokoro-v1.0.onnx and voices-v1.0.bin")
    ap.add_argument("--port", type=int, default=8880)
    ap.add_argument("--voice", default=default_voice)
    ap.add_argument("--threads", type=int, default=4, help="CPU threads for the model; more does not help much")
    ap.add_argument("--parent", type=int, help="exit when this process is gone")
    args = ap.parse_args()
    default_voice = args.voice

    options = ort.SessionOptions()
    options.intra_op_num_threads = args.threads
    options.inter_op_num_threads = 1
    session = ort.InferenceSession(
        os.path.join(args.models, "kokoro-v1.0.onnx"), sess_options=options, providers=["CPUExecutionProvider"]
    )
    kokoro = Kokoro.from_session(session, os.path.join(args.models, "voices-v1.0.bin"))
    kokoro.create("Ready.", voice=default_voice, lang=LANG.get(default_voice[:1], "en-us"))  # the first run is the slow one

    if args.parent:
        threading.Thread(target=watch_parent, args=(args.parent,), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    say(f"Kokoro-82M ready on 127.0.0.1:{args.port}, {len(kokoro.get_voices())} voices")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
