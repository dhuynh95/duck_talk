# The voice session dies, and nothing notices

Status: diagnosed, not fixed
Created: 2026-08-29

## What was seen

Claude said "Fair, let me check.", then the audio jumped from the start of one
paragraph to the middle of the next. The text on screen was complete; only the
speech skipped.

## What the logs actually say

That turn was never written to `.turns.jsonl` at all. The relay log for the
connection ends like this:

```
[7] heard: So, what is this project about?
[7] accepted: So, what is this project about?
[7] cancel (spoke over the reply)          ← a real barge-in, working correctly
[7] turn 1 end  ...  21.1s voice
[7] heard: Are you sure it's about Svelte? I think we migrated towards an iPhone app.
[7] accepted: Are you sure it's about Svelte? ...
[7] voice closed: The operation was aborted.
[7] close
```

No `turn 2 end`. The voice session closed on its own, mid-reply, and because
`onDone` never fired the turn never ended and never got recorded. Nothing in
`session.ts` reopens the voice session when it closes, so from that moment the
app is mute for the rest of the connection and no further turn is recorded.
That silence is the bug; the audio jump is what it looks like from the outside.

## It is not gradual, and it is not the obvious suspects

Milliseconds of audio per character of reply, from `.turns.jsonl`:

| reply | voice_ms | ms/char |
|---|---|---|
| 34 chars | 2340–3520 | 69–104 |
| 276 chars | 12541 | 45.4 |
| 524 chars | 21081 | 40.2 |

Long replies lose roughly 40% of their audio. Three explanations were tested:

- **Sentence chunks pre-empting each other.** Disproved. A 388-char reply pushed
  through `openVoice` as fast as Claude streams it gives 68.7 ms/char; paced one
  sentence at a time gives 64.2. Fast is not worse.
- **The session degrading as it fills up.** Disproved. Across five replies on one
  session, ms/char stayed flat (68.3, 66.1, 65.0, 65.4, 66.0) and then the sixth
  produced nothing at all — WebSocket code 1006. It works, then stops.
- **A duration or context limit.** Disproved. A raw Live session sending one
  `sendClientContent` per reply survived 8 replies over 171s with no `goAway`,
  and `totalTokenCount` grew linearly to 6139 — nowhere near any limit.

The raw session survives what `openVoice` does not. The difference between them
is the sentence chunking and the `pendingSends` bookkeeping.

## The untested suspect

`voice.ts` has no turn fencing. `interrupt()` sets `pendingSends = 0`, but
Gemini keeps sending `turnComplete` for generations already in flight. Those
arrive during the *next* turn and decrement its count, so `finishing &&
pendingSends === 0` can fire early — ending a turn whose audio is still coming.
`claude.ts` fences exactly this (`cancelledUpTo`); `voice.ts` never got the same
treatment.

That fits the sighting: the connection above was interrupted on turn 1 and the
damage showed on turn 2. It does not explain the 1006 close in a run with no
interrupt, so there may be two faults here, not one.

Next step is the experiment that was not run: one session, a clean reply, then
an interrupt mid-reply, then two more replies — and watch whether the ones after
the interrupt are short and whether `onDone` fires early.

## What a fix has to cover

1. Fence the voice turns the way `claude.ts` fences Claude's, so a cancelled
   generation's `turnComplete` cannot end the turn after it.
2. Reopen the voice session when it closes unexpectedly. The phone already does
   this for its own socket (`VoiceSession.run`); the relay does not do it for
   Gemini, and a silent permanent mute is the worst failure in the app.
3. A turn that ends because the voice died should still be recorded, so this is
   visible in `.turns.jsonl` next time instead of leaving a hole.
