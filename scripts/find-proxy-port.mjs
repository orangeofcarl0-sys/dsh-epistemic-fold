import net from 'node:net'

// Print the first local proxy port that accepts a TCP connection, else exit 1.
//
// This is a FILE rather than a node -e one-liner because the one-liner version failed
// silently under PowerShell: nested quotes in an inline script are not passed through
// reliably, so the probe reported "no port found" while the ports were plainly open --
// and the harness then fell back to direct, which is the route that dies outright.
//
// Ports are tried in the order they have actually been observed: 7890/7897 are the
// current mihomo defaults, 10808 is the one that moved and is kept last-but-one so a
// stale configuration still gets a chance before the fallback.
const PORTS = [7890, 7897, 10808, 1080, 7891, 10809];

const tryPort = (port, timeoutMs = 400) =>
  new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { try { sock.destroy(); } catch {} resolve(ok); };
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });

for (const port of PORTS) {
  if (await tryPort(port)) {
    console.log(port);
    process.exit(0);
  }
}
process.exit(1);
