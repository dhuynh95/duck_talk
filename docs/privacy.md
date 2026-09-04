# Duck Talk privacy policy

Duck Talk is a voice client for Claude Code. The app talks to one thing: a relay that
you run yourself, on your own Mac, at an address you type into the app. There is no
Duck Talk account and no Duck Talk server.

## What the app collects

Nothing. The app has no analytics, no crash reporting of its own, no advertising, and
no identifiers. It stores your settings — the relay address, the mode, the model — on
the phone, in the app's own preferences, and nowhere else.

## What leaves the phone

Only to the relay you configured, and only while you use it:

- **Microphone audio**, while you hold a session open, so the relay can transcribe what
  you say.
- **Text you type**, and **pictures you choose to attach** to a message.

The relay is open source ([github.com/dhuynh95/duck_talk](https://github.com/dhuynh95/duck_talk))
and runs on your Mac. It sends audio to Google's Gemini API for transcription and
speech, and text to Anthropic's Claude Code, under API keys and accounts that are yours.
It keeps transcripts and utterance recordings on that Mac, in a `.duck-talk/` folder of
the project you started it in, where you can read or delete them. Google's and
Anthropic's handling of what reaches them is governed by their own policies and your
agreements with them.

## Permissions

- **Microphone** — to talk to the agent.
- **Camera and photo library** — to send a picture with a question. Optional.
- **Local network** — to reach a relay on your Wi-Fi.
- **Background audio and VoIP** — to keep a session alive when the phone locks and to
  let headphone controls reach it. The app places no phone calls and receives none.

## Contact

contact@reduck.ai
