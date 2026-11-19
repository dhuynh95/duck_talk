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
# No key and no network: the relay is only asked to get as far as its own port, and
# to say two things once it holds it — that it serves the browser client's page, and
# that it turns away a socket that comes without the access key.

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

# The relay is started on a PATH of its own, holding nothing but `node` (which the
# launcher's shebang looks up). Left to find `tailscale` on the machine running this,
# it would read — and, finding the front door pointed at a port nobody listens on,
# repoint — that machine's real Tailscale at this throwaway relay. Nothing here needs
# any other program, and `-u DUCK_TALK_OPEN` keeps a shell that opens the relay up from
# hiding the access check the keyless upgrade below is there to prove.
nodebin=$(mktemp -d)
ln -s "$(command -v node)" "$nodebin/node"
env -u DUCK_TALK_OPEN PATH="$nodebin" GEMINI_API_KEY=not-a-real-key \
  ./node_modules/.bin/duck-talk --port "$PORT" >relay.log 2>&1 &
relay=$!
# The relay says where a phone can reach it once the port is actually held — see
# reach.ts — so the `simulator` row is the proof it listens. The columns are padded,
# hence the `+`.
for _ in $(seq 60); do
  grep -qE "simulator +ws://localhost:$PORT" relay.log && break
  sleep 0.25
done

# Asked while the relay is up and judged after it is gone, so a failed check still
# finds the relay stopped and its log on screen. `|| true` keeps a refused connection
# from ending the script here, with the relay still running.
#
# The page is the one `web/` ships: `packaged('../web/')` in server.ts reaches it from
# `dist/`, and only an installed package — with `web/` in `files` — shows that it does.
page=$(curl -fs "localhost:$PORT/" || true)
# A socket with no key, which the relay refuses on the upgrade itself with a 401. The
# headers are the ones a browser's WebSocket sends, so the refusal is the access check
# and not a complaint about a malformed handshake.
upgrade=$(curl -s -o /dev/null -w '%{http_code}' \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==' "localhost:$PORT/?data=1" || true)
{ kill "$relay" && wait "$relay"; } 2>/dev/null || true

sed 's/^/  /' relay.log
grep -qE "simulator +ws://localhost:$PORT" relay.log
# The folder it was started in is the folder it serves — the whole point of the
# package, and the one thing a test run from inside the repo could never tell you.
grep -qE "project +$work" relay.log
echo "started from $work"
grep -q '<title>' <<<"$page"
echo "serves its page"
[ "$upgrade" = 401 ]
echo "refuses a socket with no key"
