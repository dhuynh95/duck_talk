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
import itertools
import json
import re
import shlex
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import NotRequired, TypedDict, cast

from fastmcp import FastMCP
from fastmcp.utilities.types import Image

mcp = FastMCP("iOS Simulator")

APP_DIR = Path(__file__).parent
DT = str(APP_DIR / "dt")
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
    and then died. Call this after editing Swift; there is no separate build step."""
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


@mcp.tool
async def ui(x: int | None = None, y: int | None = None) -> str:
    """The accessibility tree: what's on screen as structured data, with frames in
    point space, so you can tap what you find. Pass x and y to describe only the
    element at that point (matching something you see in a screenshot). Nodes with
    no label, identifier, or value are omitted unless they're containers."""
    if x is not None and y is not None:
        out, err, code = await _axe("describe-ui", "--point", f"{x},{y}")
        if code != 0:
            raise RuntimeError((err or out).strip())
        # `describe-ui` returns a list of roots; `--point` returns the one node.
        tree = [cast(AXNode, json.loads(out))]
    else:
        tree = await _ax_tree()

    interesting = {
        "Application",
        "ScrollView",
        "Table",
        "CollectionView",
        "NavigationBar",
    }
    lines: list[str] = []

    def walk(node: AXNode, depth: int = 0) -> None:
        f = node.get("frame") or {}
        label, ident = node.get("AXLabel"), node.get("AXUniqueId")
        value, kind = node.get("AXValue"), node.get("type") or node.get("role")
        if label or ident or value or kind in interesting:
            parts = [kind or "?"]
            if ident:
                parts.append(f'id="{ident}"')
            if label:
                parts.append(f'label="{label}"')
            if value not in (None, ""):
                parts.append(f'value="{value}"')
            parts.append(
                "frame=[{},{},{},{}]".format(
                    *(round(f.get(k, 0)) for k in ("x", "y", "width", "height"))
                )
            )
            if node.get("enabled") is False:
                parts.append("disabled")
            lines.append("  " * depth + " ".join(parts))
            depth += 1
        for child in node.get("children") or []:
            walk(child, depth)

    for root in tree:
        walk(root)
    w, h = await _point_size()
    header = f"screen: {w}x{h} points"
    return header + "\n" + ("\n".join(lines) or "(nothing labelled on screen)")


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


if __name__ == "__main__":
    mcp.run()
