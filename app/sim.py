"""iOS Simulator MCP — computer-use tools over a booted iPhone simulator.

Two collaborators, one job each. `./dt` owns the app lifecycle (xcodegen,
xcodebuild, boot, install, launch, logs); `axe` owns input and the accessibility
tree. This file is the model-facing surface over both: every action that changes
the screen returns the screen it produced, so acting and seeing are one round trip.

One coordinate space, on purpose. The accessibility tree reports frames in POINTS
(402x874 on an iPhone 17 Pro) and `axe` consumes points, so screenshots are scaled
from device pixels (1206x2622) down to exactly that size. The number the model
reads off the image is the number it passes back to `tap`. No scaling helpers, no
geometry constants, no per-device configuration.
"""

import asyncio
import atexit
import itertools
import json
import os
import re
import shlex
import subprocess
import time
from collections.abc import Awaitable, Callable, Iterator
from pathlib import Path
from typing import NotRequired, TypedDict, cast

from fastmcp import FastMCP
from fastmcp.utilities.types import Image

mcp = FastMCP("iOS Simulator")

APP_DIR = Path(__file__).parent
DT = str(APP_DIR / "dt")
HOST = os.environ.get("SIM_HOST", "127.0.0.1")
PORT = int(os.environ.get("SIM_PORT", "8766"))
SHOT_RAW = "/tmp/ios_screen.png"
SHOT_PT = "/tmp/ios_screen_pt.png"
TYPE_FILE = "/tmp/ios_type.txt"
SETTLE = 0.4  # let SwiftUI finish its animation before we look

_udid_cache: str | None = None
_pt_size_cache: tuple[int, int] | None = None
_frame_seq = itertools.count()  # unique filenames for exec_code's attached frames


async def _sh(cmd: str) -> tuple[str, str, int]:
    """Run a shell command from app/. The one primitive everything else sits on."""
    proc = await asyncio.create_subprocess_shell(
        cmd,
        cwd=str(APP_DIR),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate()
    return out.decode(), err.decode(), proc.returncode or 0


async def _udid() -> str:
    """Target simulator, booting it if needed. `dt` already knows how; ask it."""
    global _udid_cache
    if _udid_cache is None:
        out, err, code = await _dt("udid")
        if code != 0:
            raise RuntimeError(f"no simulator: {err.strip() or out.strip()}")
        _udid_cache = out.strip().splitlines()[-1]
    return _udid_cache


async def _dt(sub: str) -> tuple[str, str, int]:
    """Run a `dt` subcommand — the app lifecycle lives there, not here."""
    return await _sh(f"{DT} {sub}")


async def _axe(*args: str) -> tuple[str, str, int]:
    quoted = " ".join(shlex.quote(a) for a in args)
    return await _sh(f"axe {quoted} --udid {await _udid()}")


class AXNode(TypedDict):
    """One node of `axe describe-ui`'s output. Frames are in points."""

    frame: dict[str, float]
    type: NotRequired[str]
    role: NotRequired[str]
    AXLabel: NotRequired[str | None]
    AXUniqueId: NotRequired[str | None]
    AXValue: NotRequired[str | None]
    enabled: NotRequired[bool]
    children: NotRequired[list["AXNode"]]


async def _ax_tree() -> list[AXNode]:
    out, err, code = await _axe("describe-ui")
    if code != 0:
        raise RuntimeError(f"describe-ui failed: {err.strip() or out.strip()}")
    return cast(list[AXNode], json.loads(out))


def _walk(nodes: list[AXNode]) -> Iterator[AXNode]:
    for node in nodes:
        yield node
        yield from _walk(node.get("children", []))


async def _status() -> str:
    """What the app's status line says: idle, connecting or live. The screen is the
    only place the session state is published, so read it there."""
    for node in _walk(await _ax_tree()):
        if node.get("AXLabel") == "Status":
            return (node.get("AXValue") or "").split(",")[0].strip()
    return "unknown"


async def _point_size() -> tuple[int, int]:
    """Screen size in points, read from the accessibility root's own frame.
    Cached — it's a property of the simulator, not of the moment."""
    global _pt_size_cache
    if _pt_size_cache is None:
        frame = (await _ax_tree())[0]["frame"]
        _pt_size_cache = (round(frame["width"]), round(frame["height"]))
    return _pt_size_cache


async def _shot() -> Image:
    """Capture the screen and scale it to point size, so image coordinates and
    tap coordinates are the same numbers."""
    _ = await _sh(f"xcrun simctl io {await _udid()} screenshot --type=png {SHOT_RAW}")
    w, h = await _point_size()
    _ = await _sh(f"sips -z {h} {w} {SHOT_RAW} --out {SHOT_PT}")
    return Image(path=SHOT_PT)


async def _act(coro: Awaitable[tuple[str, str, int]]) -> Image:
    """Do a thing, let the UI settle, hand back what the screen looks like now."""
    out, err, code = await coro
    if code != 0:
        raise RuntimeError((err or out).strip() or "axe failed")
    await asyncio.sleep(SETTLE)
    return await _shot()


# --------------------------------------------------------------------------- #
# Tools                                                                       #
# --------------------------------------------------------------------------- #


@mcp.tool
async def run():
    """Build the app, install it, launch it, and show the result — the whole
    edit-and-see loop in one call. Returns a screenshot when the app is running,
    the compiler's errors when the build failed, or the log tail when it launched
    and then died. Call this after editing Swift; there is no separate build step.

    Also points the Mac's microphone at the virtual device, so the app that comes up
    is always one `play_audio` can talk to."""
    # An app builds its audio session at launch from the devices the Mac has then,
    # and a route change afterwards breaks it. Set the route first; if it moved,
    # shut the simulator down and let `dt run` boot it again underneath.
    if await _ensure_route():
        _ = await _sh(f"xcrun simctl shutdown {await _udid()}")
    out, err, code = await _dt("run")
    if code != 0:
        return f"BUILD FAILED\n{(out + err).strip() or '(no output)'}"

    # `simctl launch` reports "<bundle>: <pid>" — no need to hardcode the id.
    match = re.search(r"^(\S+): (\d+)", out.strip(), re.M)
    if not match:
        return f"launch produced no pid\n{(out + err).strip()}"
    bundle = match.group(1)

    await asyncio.sleep(1.2)
    alive, _, _ = await _sh(
        f"xcrun simctl spawn {await _udid()} launchctl list | grep {bundle}"
    )
    if not alive.strip():
        logs, _, _ = await _dt("logs 3")
        return f"{bundle} launched and exited.\n{logs.strip() or '(no log output)'}"
    return await _shot()


@mcp.tool
async def screenshot() -> Image:
    """Screenshot the simulator, scaled to point size — coordinates you read off
    this image can be passed straight to tap and swipe."""
    return await _shot()


@mcp.tool
async def tap(
    x: int | None = None,
    y: int | None = None,
    label: str | None = None,
    id: str | None = None,
    element_type: str | None = None,
) -> Image:
    """Tap the screen, by point or by accessibility label/identifier — prefer a
    label, it survives layout changes and needs no prior look at the UI tree
    (e.g. tap(label="Quack")). Points are in point space (see screenshot).
    `element_type` (Button, TextField, Switch…) disambiguates multiple matches.
    Waits briefly for the element to appear. Returns a screenshot after tapping."""
    args = ["tap"]
    if x is not None and y is not None:
        args += ["-x", str(x), "-y", str(y)]
    elif label:
        args += ["--label", label, "--wait-timeout", "3"]
    elif id:
        args += ["--id", id, "--wait-timeout", "3"]
    else:
        raise ValueError("give either x and y, or label, or id")
    if element_type:
        args += ["--element-type", element_type]
    return await _act(_axe(*args))


@mcp.tool
async def swipe(
    start_x: int, start_y: int, end_x: int, end_y: int, duration: float = 0.3
) -> Image:
    """Swipe between two points (point space) — scrolling, dragging, dismissing.
    Returns a screenshot after the gesture."""
    return await _act(
        _axe(
            "swipe",
            "--start-x",
            str(start_x),
            "--start-y",
            str(start_y),
            "--end-x",
            str(end_x),
            "--end-y",
            str(end_y),
            "--duration",
            str(duration),
        )
    )


@mcp.tool
async def type_text(text: str) -> Image:
    """Type into the focused field. Tap the field first. US-keyboard characters
    only (a HID limitation: no accents, no £/€). Returns a screenshot after typing."""
    _ = Path(TYPE_FILE).write_text(text)
    return await _act(_axe("type", "--file", TYPE_FILE))


# --------------------------------------------------------------------------- #
# Voice: speak to the app, then read what the turn actually did                #
# --------------------------------------------------------------------------- #
# Injection is a black box: `say` plays into "BlackHole 2ch", the device the app
# listens to, so a turn goes through the real microphone path. The result is not
# inferred from sound — the relay writes every finished turn to .turns.jsonl, with
# the phone's own timestamp for when the reply reached it.
#
# The phone (in the simulator), the relay and this file all run on this Mac, so
# every timestamp is the same clock and latency is a subtraction. Nothing is
# thresholded, calibrated or detected.

VOICE_IN = "BlackHole 2ch"  # app's microphone; we play into it
SAY_VOICE = "Samantha"
TURNS = APP_DIR.parent / "server" / ".turns.jsonl"
ROUTE_MEMO = (
    APP_DIR / ".build" / "audio-route.json"
)  # the user's input device, before we moved it


async def _device(kind: str) -> str:
    out, _, _ = await _sh(f"SwitchAudioSource -c -t {kind}")
    return out.strip()


async def _av_index(name: str) -> str:
    """avfoundation renumbers devices between runs — always resolve by name."""
    out, err, _ = await _sh('ffmpeg -f avfoundation -list_devices true -i ""')
    in_audio = False
    for line in (out + err).splitlines():
        if "audio devices" in line:
            in_audio = True
            continue
        m = re.search(r"\[(\d+)\] (.+)$", line)
        if in_audio and m and m.group(2).strip() == name:
            return m.group(1)
    raise RuntimeError(f"no audio device named {name!r} — is BlackHole installed?")


async def _ensure_route() -> bool:
    """Point the app's microphone at the virtual device. Returns True if it had to
    change, which run() answers by restarting the simulator — an audio session built
    before the change keeps using the old device and every connect fails.

    Only the input is ours. The reply plays out of whatever the Mac already uses, so
    you can hear the turn happen, and no second virtual device has to be working."""
    have = await _device("input")
    if have == VOICE_IN:
        return False
    # Remember the user's device in a file rather than a global: the reloader
    # replaces this process on every edit, and a device only a dead process
    # remembered is one the user has to put back by hand.
    if not ROUTE_MEMO.exists():
        ROUTE_MEMO.parent.mkdir(parents=True, exist_ok=True)
        _ = ROUTE_MEMO.write_text(json.dumps(have))
    _ = await _sh(f'SwitchAudioSource -t input -s "{VOICE_IN}"')
    if await _device("input") != VOICE_IN:
        raise RuntimeError(f"input would not switch to {VOICE_IN!r}")
    return True


@atexit.register
def _restore_route() -> None:
    """Put the user's microphone back when this server stops for good.

    A hot reload kills the worker without running this, which is what we want — the
    device has to survive an edit, or the app running on it goes deaf mid-session."""
    if not ROUTE_MEMO.exists():
        return
    _ = subprocess.run(
        ["SwitchAudioSource", "-t", "input", "-s", json.loads(ROUTE_MEMO.read_text())],
        capture_output=True,
    )
    ROUTE_MEMO.unlink()


async def _require_route() -> None:
    have = await _device("input")
    if have != VOICE_IN:
        raise RuntimeError(
            f"the app's microphone is {have!r}, not {VOICE_IN!r} — call run(), "
            + "which sets it before the simulator boots."
        )


def _turns() -> list[dict[str, object]]:
    """Every turn the relay has recorded, oldest first."""
    if not TURNS.exists():
        return []
    return [json.loads(line) for line in TURNS.read_text().splitlines() if line.strip()]


async def _find(identifier: str) -> str | None:
    """The text of the view with this accessibility identifier, if it is on screen."""
    for node in _walk(await _ax_tree()):
        if node.get("AXUniqueId") == identifier:
            return node.get("AXLabel") or node.get("AXValue")
    return None


async def _try_connect() -> bool:
    if await _status() == "live":
        return True
    _ = await _axe("tap", "--label", "Connect", "--wait-timeout", "3")
    for _attempt in range(10):
        await asyncio.sleep(0.5)
        if await _status() == "live":
            return True
    return False


async def _require_live() -> None:
    """The app can only answer while connected, so connect it rather than failing."""
    if await _try_connect():
        return
    # CoreAudio changing under a booted simulator — a device switch, a coreaudiod
    # restart, a sleep — leaves every audio session inside it unable to open the
    # microphone, and relaunching the app does not clear it. Restarting the
    # simulator does. There is no way to see that state coming, so recover from it.
    problem = await _find("error")
    _ = await _sh(f"xcrun simctl shutdown {await _udid()}")
    _ = await _dt("run")
    await asyncio.sleep(1.5)
    if await _try_connect():
        return
    raise RuntimeError(
        "the app would not go live, even after restarting the simulator. "
        + f"It says: {await _find('error') or problem or '(no error on screen)'}"
    )


@mcp.tool
async def play_audio(
    text: str | None = None, file: str | None = None, wait: float = 30.0
):
    """Speak to the app as a user would, then report what the turn actually did —
    the whole voice turn in one call.

    Plays `text` (synthesized) or an audio `file` into the device the app listens to,
    then waits up to `wait` seconds for the relay to finish a turn and reads it from
    `server/.turns.jsonl`. Returns that turn plus a screenshot of the app.

    latency_ms  question finished playing → the relay sent the first reply byte.
                Gemini's thinking plus both network legs, as a user waits through it.
    to_phone_ms that byte → the phone says it arrived. What relaying through the Mac
                costs, which is the question Architecture B has to answer.
    voice_ms    reply audio the relay sent, exact (24 kHz Int16 is 48 bytes/ms).
    heard/said  what Gemini made of the question, and what it answered.

    Every timestamp is taken on this Mac — by the harness, the relay, and the app in
    the simulator — so these are subtractions, not measurements. Nothing is detected
    from sound and nothing is thresholded.

    Needs `brew install --cask blackhole-2ch` and an app that run() launched.
    Connects the app if it isn't. The reply plays out loud, on purpose."""
    if not text and not file:
        raise ValueError("give either text or a file")
    await _require_route()
    await _require_live()

    before = len(_turns())
    if file:
        # audiotoolbox plays to a named device, so the default output stays put.
        index = await _av_index(VOICE_IN)
        _ = await _sh(
            f"ffmpeg -v error -i {shlex.quote(file)} -f audiotoolbox "
            + f"-audio_device_index {index} -"
        )
    else:
        _ = await _sh(
            f"say -a {shlex.quote(VOICE_IN)} -v {SAY_VOICE} -- {shlex.quote(text or '')}"
        )
    asked_at = time.time() * 1000  # `say` returns once the audio has been played

    deadline = time.monotonic() + wait
    turn: dict[str, object] | None = None
    while time.monotonic() < deadline:
        recorded = _turns()
        if len(recorded) > before:
            turn = recorded[-1]
            break
        await asyncio.sleep(0.2)
    if turn is None:
        return [
            f"FAILED: the relay finished no turn within {wait:.0f}s. Its log says "
            + "whether the question reached Gemini at all.",
            await _shot(),
        ]

    out_at, in_at = turn.get("reply_out_at"), turn.get("reply_in_at")
    if not isinstance(out_at, (int, float)):
        return [
            f"FAILED: the turn carried no reply audio. heard={turn.get('heard')!r}",
            await _shot(),
        ]
    metrics = {
        "latency_ms": round(out_at - asked_at),
        "to_phone_ms": round(in_at - out_at) if isinstance(in_at, (int, float)) else None,
        "voice_ms": round(cast(float, turn.get("voice_ms", 0))),
        "heard": turn.get("heard"),
        "said": turn.get("said"),
    }
    return [json.dumps(metrics), await _shot()]


@mcp.tool
async def logs(seconds: int = 10) -> str:
    """The app's os_log and stdout for the next N seconds — for crashes, prints,
    and anything the screen doesn't show. Trigger the behaviour while this runs."""
    out, err, _ = await _dt(f"logs {seconds}")
    return (out + err).strip() or "(no log output)"


def _scope() -> dict[str, object]:
    """The shared realm for exec_code. Anything reusable enough to promote into a
    saved script runs in exactly this scope, so a working snippet moves verbatim."""
    return {
        "sh": _sh,
        "dt": _dt,
        "axe": _axe,
        "shot": _shot,
        "ax_tree": _ax_tree,
        "udid": _udid,
        "point_size": _point_size,
        "SHOT_PT": SHOT_PT,
        "asyncio": asyncio,
        "json": json,
        "re": re,
        "Path": Path,
    }


@mcp.tool
async def exec_code(code: str):
    """Run async Python in the server process — the escape hatch when no tool fits
    (a multi-step flow, a loop until some state, arbitrary simctl/axe calls).

    In scope: `sh(cmd)` -> (stdout, stderr, code) runs a shell command from app/;
    `dt(sub)` runs a dt subcommand; `axe(*args)` runs axe with --udid filled in;
    `shot()` -> scaled screenshot at SHOT_PT; `ax_tree()` -> parsed accessibility
    JSON; `udid()`; `point_size()` -> (w, h) in points. Plus `asyncio`, `json`,
    `re`, `Path`. Top-level `await` is allowed. print() for output; a `return`
    value is JSON-serialized; `attach_image(path)` returns an image to the client —
    call it after each shot() in a loop to get every frame, reusing SHOT_PT freely."""
    import contextlib
    import io
    import textwrap
    import traceback

    images: list[str] = []

    def attach_image(path: str) -> None:
        """Copy the file now, so a caller looping over shot() gets one image per
        frame instead of the last frame repeated."""
        frame = f"/tmp/ios_frame_{next(_frame_seq)}.png"
        _ = Path(frame).write_bytes(Path(path).read_bytes())
        images.append(frame)

    namespace: dict[str, object] = {**_scope(), "attach_image": attach_image}
    buf = io.StringIO()
    try:
        exec("async def __exec():\n" + textwrap.indent(code, "    "), namespace)
        body = cast(Callable[[], Awaitable[object]], namespace["__exec"])
        with contextlib.redirect_stdout(buf):
            result = await body()
    except Exception:
        return buf.getvalue() + traceback.format_exc()

    out = buf.getvalue()
    if result is not None:
        out = (out + "\n" if out else "") + json.dumps(
            result, ensure_ascii=False, default=str
        )
    out = out or "(no output)"
    return [out, *(Image(path=p) for p in images)] if images else out


# Served over HTTP at a fixed URL rather than spawned by the client over stdio, so
# the reloader can replace this process on every edit and the next tool call already
# runs the new code. A stdio server is owned by the client and only picks up a change
# when the client itself restarts.
app = mcp.http_app(path="/mcp")

if __name__ == "__main__":
    mcp.run(transport="http", host=HOST, port=PORT, path="/mcp")
