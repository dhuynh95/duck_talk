"""The filler chimes, synthesized — run from the repo root, writes the app's copy.

The sound the app loops while a reply is owed and no audio for it has arrived:
five soft pentatonic plucks over a faint ground, eight seconds, seamless. Like the
app icon, the asset is generated and never edited by hand — every quality of the
sound is a number below, so "slower", "quieter" or "different notes" is an edit
here and a re-run, not a session in an audio editor.

Seamlessness is arithmetic, not luck: every frequency is snapped to whole cycles
per loop, and each pluck's four-second ring is added modulo the loop length, so
the tail that spills past the end is exactly what plays under the beginning.

    python3 scripts/filler-sound.py
"""

import math
import struct
import wave

RATE = 24_000  # the speaker format AudioPipe already plays
DUR = 8
N = RATE * DUR
OUT = "app/DuckTalk/Resources/chimes.wav"


def snap(f: float) -> float:
    """The nearest frequency that completes whole cycles in the loop."""
    return round(f * DUR) / DUR


out = [0.0] * N
# The ground: a faint fifth (C4 + G4), so the plucks land on something.
for i in range(N):
    t = i / RATE
    out[i] = 0.05 * (math.sin(2 * math.pi * snap(261.63) * t) + math.sin(2 * math.pi * snap(392.0) * t))

# The plucks: C E G A D, pentatonic — no interval in it can sound wrong against
# the ground, whichever pluck the loop is cut off at when the reply arrives.
for start, f in [(0.0, 523.25), (1.6, 659.26), (3.2, 783.99), (4.7, 880.0), (6.3, 587.33)]:
    f = snap(f)
    for j in range(RATE * 4):
        t = j / RATE
        env = math.exp(-t / 0.9) * min(1, j / 200)  # soft attack, long decay
        v = env * (math.sin(2 * math.pi * f * t) + 0.25 * math.exp(-t / 0.3) * math.sin(2 * math.pi * 2 * f * t))
        out[(int(start * RATE) + j) % N] += 0.18 * v

peak = max(abs(s) for s in out)
with wave.open(OUT, "w") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(RATE)
    w.writeframes(b"".join(struct.pack("<h", int(s / peak * 0.30 * 32767)) for s in out))
print(f"{OUT}  {DUR}s, peak -10.5 dBFS")
