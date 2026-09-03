#!/usr/bin/env bash
#
# Install the package the way a stranger would, and start it somewhere that is not
# this repo.
#
# Everything that makes `npx duck-talk` work rather than `npm start` is invisible from
# inside the checkout: a file missing from `files`, a prompt the build forgot to copy,
# an import that only resolved because the sources happened to be next door, state
# written beside the code instead of beside the project. All of it shows up here, on
# the line the relay prints before it listens — so this runs on every push and again
# before anything is published.
#
# No key and no network: the relay is only asked to get as far as its own port.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${PORT:-8790}"
tarball_dir=$(mktemp -d)
tarball="$tarball_dir/$(npm pack --silent --pack-destination "$tarball_dir")"

# Somewhere with no relation to this repo, so a path that only works from here fails.
work=$(mktemp -d)
cd "$work"
work=$(pwd -P) # what the relay will print: on macOS mktemp hands back a symlink
npm init -y >/dev/null
npm install --no-audit --no-fund --silent "$tarball"

./node_modules/.bin/duck-talk --help >/dev/null
echo "--help ok"

GEMINI_API_KEY=not-a-real-key ./node_modules/.bin/duck-talk --port "$PORT" >relay.log 2>&1 &
relay=$!
# The relay says where a phone can reach it once the port is actually held — see
# reach.ts — so the `simulator` row is the proof it listens. The columns are padded,
# hence the `+`.
for _ in $(seq 60); do
  grep -qE "simulator +ws://localhost:$PORT" relay.log && break
  sleep 0.25
done
{ kill "$relay" && wait "$relay"; } 2>/dev/null || true

sed 's/^/  /' relay.log
grep -qE "simulator +ws://localhost:$PORT" relay.log
# The folder it was started in is the folder it serves — the whole point of the
# package, and the one thing a test run from inside the repo could never tell you.
grep -qE "project +$work" relay.log
echo "started from $work"
