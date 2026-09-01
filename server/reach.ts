/**
 * Every address a phone can reach this relay at, said by the one process that knows.
 *
 * Three rows, for the three places a phone can be. The relay bound the socket, so it
 * knows the port; the Mac's own interfaces say what the LAN calls it; and Tailscale,
 * when it is set up, keeps a record of the front door it holds open — read here, and
 * repointed only when it leads nowhere. Nothing else has to guess an address, which is
 * what let `dt` and the app each carry one and disagree.
 *
 *   simulator    the app running on this Mac
 *   same Wi-Fi   a phone on the same network, plain ws:// to a private address
 *   anywhere     a phone on cellular, which needs a tunnel — and needs wss://, because
 *                iOS refuses cleartext to anything that is not a private address
 *
 * The third row is Tailscale because it is the one tunnel that needs no third party
 * and hands out a real certificate: `tailscale serve --bg 8765`, once, and the phone
 * dials `wss://<mac>.<tailnet>.ts.net` — with no port in it, because the front door is
 * 443 and forwards to 8765 on its own. That last fact is why the port is fixed: a
 * relay that stepped to 8766 would still be behind a door that opens onto 8765.
 *
 * Which is where the one write comes in. A door onto a port where something is
 * listening belongs to whatever is behind it, and is reported and left alone. A door
 * onto a port where nothing is listening belongs to nobody — taking it cannot steal a
 * phone from anyone, because no phone is reaching anything through it — so this
 * repoints it at the running relay and says so. Without that, a `wss://` address
 * resolves, presents a valid certificate, and answers nothing, which is the one
 * failure a phone on cellular cannot tell apart from a bad Wi-Fi day.
 */

import { execFile } from 'node:child_process';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface Reach {
  simulator: string;
  /** Null when the Mac has no private IPv4 address — offline, or a VM with none. */
  wifi: string | null;
  /** The address, or one line saying what is missing for there to be one. */
  anywhere: string;
}

export async function reach(port: number): Promise<Reach> {
  return {
    simulator: `ws://localhost:${port}`,
    wifi: lan().map((ip) => `ws://${ip}:${port}`)[0] ?? null,
    anywhere: await tailnet(port),
  };
}

/** The Mac's private IPv4 addresses, the ones a phone on the same Wi-Fi can dial. */
function lan(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) out.push(a.address);
    }
  }
  return out;
}

/** Whether anything holds `port` on this Mac right now — one TCP connection, asked of
 *  the port itself rather than inferred from a process list. */
function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    const answer = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(500);
    socket.once('connect', () => answer(true));
    socket.once('timeout', () => answer(false));
    socket.once('error', () => answer(false));
  });
}

/**
 * What Tailscale is doing for this port, from its own record of it — and, when that
 * record points nowhere, what this relay did about it.
 *
 * `tailscale serve status --json` lists the front doors this machine holds open and
 * the local port behind each. A door onto some other port used to be reported as a
 * collision either way, which was wrong half the time and misleading in exactly the
 * case that matters: told "stop that one", there was no "that one" to stop. So the
 * port behind the door is asked whether anyone is home, and the answer splits the
 * two states that were one — someone else's door, reported; nobody's door, taken.
 */
async function tailnet(port: number): Promise<string> {
  let json: string;
  try {
    ({ stdout: json } = await run('tailscale', ['serve', 'status', '--json'], { timeout: 3_000 }));
  } catch {
    return 'not reachable off Wi-Fi — a tunnel is needed, see README › Anywhere';
  }
  const doors = (JSON.parse(json) as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> }).Web ?? {};
  for (const [hostPort, door] of Object.entries(doors)) {
    const proxy = door.Handlers?.['/']?.Proxy;
    if (!proxy) continue;
    const host = hostPort.replace(/:443$/, '');
    const behind = Number(new URL(proxy).port);
    if (behind === port) return `wss://${host}`;
    if (await listening(behind)) {
      return `wss://${host} opens onto :${behind}, where another relay is running — stop it, or serve this port`;
    }
    try {
      await run('tailscale', ['serve', '--bg', String(port)], { timeout: 5_000 });
      return `wss://${host}  (repointed from :${behind}, where nothing was listening)`;
    } catch {
      return `wss://${host} opens onto :${behind}, where nothing is listening — run:  tailscale serve --bg ${port}`;
    }
  }
  return `run once on this Mac:  tailscale serve --bg ${port}`;
}
