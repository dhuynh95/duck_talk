#!/usr/bin/env node
/**
 * `duck-talk` — the relay, started in whatever folder you are standing in.
 *
 * This file is the whole entry point, in the repo and in the package alike: the
 * shebang survives compilation, so `bin` points straight at the built version of it
 * and there is no wrapper script whose only job is to import this one.
 *
 * That folder is the whole of the configuration: it is the project Claude works in,
 * so it decides which chats the drawer lists and what `?resume=` can carry on, and it
 * is where the relay keeps what it learns — see paths.ts. Point your phone at the
 * printed address and the conversation is about the code you are in.
 *
 * Everything this parses is also an environment variable, because the relay reads
 * environment variables and nothing else: a flag is set here and then handed on, so
 * there is one place that decides and one place that reads.
 *
 *   duck-talk                       serve this folder on :8765
 *   duck-talk --port 9000 --cwd ~/work/api
 *   duck-talk --awake               and keep this Mac from idle sleep meanwhile
 */

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  if (at >= 0 && argv[at + 1] !== undefined) return argv[at + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline?.slice(name.length + 3);
}

// The folder first, because everything after it is read relative to it: paths.ts takes
// PROJECT_CWD when it loads, so it is imported only once this line has run — and so
// is everything that imports it, which is the reason the imports below are dynamic.
const project = resolve(flag('cwd') ?? process.env['PROJECT_CWD'] ?? process.cwd());
process.env['PROJECT_CWD'] = project;
const { VERSION } = await import('./paths.ts');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`duck-talk ${VERSION} — talk to Claude Code from your phone

  duck-talk [--port <n>] [--cwd <path>]

  --port <n>    which port to listen on (default 8765). Fixed on purpose: a
                Tailscale front door opens onto one port, and moving would leave
                the phone talking to whatever is still behind it.
  --cwd <path>  the project Claude works in (default: this folder)
  --awake       keep this Mac from idle sleep while the relay runs (KEEP_AWAKE=1).
                Idle sleep only: a closed lid still sleeps the Mac.
  --version     print the version and exit

Needs GEMINI_API_KEY in the environment or in a .env file in this folder, and
Claude Code signed in — or ANTHROPIC_API_KEY, which bills the API instead.
Get a Gemini key at https://aistudio.google.com/apikey (the free tier is enough).`);
  process.exit(0);
}

if (argv.includes('--version') || argv.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

// A key belongs to the project you are in, so the .env that counts is the one in the
// folder you started from. Loaded before anything reads it, and never over a variable
// the shell already set — an explicit export outranks a file.
for (const file of [resolve(project, '.env'), resolve(process.cwd(), '.env')]) {
  try { process.loadEnvFile(file); break; } catch { /* no .env here, which is normal */ }
}

// From here on the terminal is also a file — one per start, a week each, under the
// project's state directory.
const logFile = (await import('./log.ts')).openLog();

if (!process.env['GEMINI_API_KEY']) {
  console.error(`duck-talk needs a Gemini key to hear you and to speak.

  export GEMINI_API_KEY=...        or put it in .env, in this folder

Get one free, no card, at https://aistudio.google.com/apikey`);
  process.exit(1);
}

// Billing is the one setting that spends money quietly. Claude Code uses the account
// you signed in with unless this is set, and then every turn is charged to the API
// instead. It is a legitimate choice, so this does not stop — but it is not something
// to learn from an invoice, so it is said before anything runs and said in red.
if (process.env['ANTHROPIC_API_KEY']?.trim()) {
  const red = process.stderr.isTTY ? '\x1b[1;31m' : '';
  const off = process.stderr.isTTY ? '\x1b[0m' : '';
  console.error(
    `${red}!!  ANTHROPIC_API_KEY is set — every turn bills the API, not your Claude subscription.${off}\n` +
    '    Run `unset ANTHROPIC_API_KEY` (and check .env) to use the subscription instead.',
  );
}

const port = flag('port');
if (port) process.env['PORT'] = port;

// A phone reaching a Mac that has gone to sleep reads "Offline", with nothing to say
// why — so the relay can hold the Mac awake for as long as it serves. Off unless asked:
// a command run by `npx` must not rewrite the machine's power policy on its own, and a
// laptop kept awake in a bag is real damage. Said at startup either way, because the
// moment to learn the flag exists is now and not after a night of silence.
//
// `caffeinate -w` ties the assertion to this pid, so it ends however this process ends
// and there is nothing to release. Idle sleep only (`-i`): a closed lid still sleeps,
// and the setting that changes that needs sudo, which is not this tool's to ask for.
if (argv.includes('--awake')) process.env['KEEP_AWAKE'] = '1';
const awake = process.platform === 'darwin' && process.env['KEEP_AWAKE'] === '1';
if (awake) {
  spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' })
    .on('error', (e) => console.error(`could not keep the Mac awake: ${e.message}`))
    .unref(); // holds the Mac, not the event loop
}

console.log(`duck-talk ${VERSION}\n  project      ${project}\n  log          ${logFile}`);
if (process.platform === 'darwin') {
  console.log(`  awake        ${awake ? 'keeping this Mac from idle sleep' : 'no — pass --awake, or set KEEP_AWAKE=1, to keep this Mac from sleeping'}`);
}
await import('./server.ts');
