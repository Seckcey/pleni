// Home Wi-Fi access. When the person switches it on, and a password is set, Pleni also listens on
// the home-network addresses of this computer that the person chose (10.x, 172.16-31.x and
// 192.168.x only, never a public one), so phones and other computers on the same Wi-Fi can open it
// without Tailscale. On another network the computer gets another address, which Pleni does not
// answer on until the person chooses it too. It looks again every 30 seconds, because an address
// can come and go when the Wi-Fi reconnects.
import os from 'node:os';

const LOOK_EVERY_MS = 30 * 1000;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// Adapters made by virtual machines, containers and VPNs: listed after the real Wi-Fi and Ethernet.
const VIRTUAL = /vethernet|virtual|vmware|vbox|hyper-v|docker|wsl|^br-|^veth|^virbr|^vmnet|^utun|^tun|^tap|^zt|tailscale/i;

// True for a dotted IPv4 address such as 192.168.1.23.
export function isIPv4(ip) {
  const m = IPV4.exec(typeof ip === 'string' ? ip : '');
  return !!m && m.slice(1).every((part) => Number(part) <= 255);
}

// True for an IPv4 address that only a home or office network uses (RFC 1918).
export function isHomeAddress(ip) {
  if (!isIPv4(ip)) return false;
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

// This computer's home-network addresses, [{ address, name }], the likeliest Wi-Fi one first:
// 192.168.x, then 10.x, then 172.16-31.x, each with real adapters before virtual ones.
export function homeAddresses(interfaces = os.networkInterfaces()) {
  const found = new Map();
  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const entry of Array.isArray(list) ? list : []) {
      const v4 = entry?.family === 'IPv4' || entry?.family === 4;
      if (v4 && !entry.internal && isHomeAddress(entry.address) && !found.has(entry.address)) {
        found.set(entry.address, { address: entry.address, name: String(name).slice(0, 60) });
      }
    }
  }
  const rank = ({ address, name }) => {
    const first = address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2;
    return first * 2 + (VIRTUAL.test(name) ? 1 : 0);
  };
  const number = (ip) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  return [...found.values()].sort((a, b) => rank(a) - rank(b) || number(a.address) - number(b.address));
}

// `makeServer()` gives a new http.Server that answers like Pleni's own; `isOn()` says whether
// Wi-Fi access should be on now; `allowed()` lists the addresses the person chose; `port()` is the
// port to use (Pleni's own, so only the first part of the address differs). `addresses`
// (homeAddresses, which keeps only home-network ones) and `every` are for tests.
export function createLan({ makeServer, isOn, allowed, port, addresses = homeAddresses, every = LOOK_EVERY_MS }) {
  const listeners = new Map();
  let timer = null;
  let closed = false;
  let running = Promise.resolve();

  // Starts and stops listeners until they match the addresses wanted now. Calls wait for each other.
  function refresh() {
    running = running.then(sync, sync);
    return running;
  }

  async function sync() {
    if (closed) return;
    const chosen = new Set(safeAllowed());
    const wanted = isOn() ? safeAddresses().filter((a) => chosen.has(a.address)) : [];
    const names = new Map(wanted.map((a) => [a.address, a.name]));
    for (const [address, entry] of listeners) {
      // A listener that failed is dropped, so the next look tries it again.
      if (!names.has(address) || entry.error) await stop(address, entry);
    }
    for (const { address, name } of wanted) {
      const entry = listeners.get(address);
      if (entry) entry.name = name;
      else await begin(address, name);
    }
  }

  function safeAddresses() {
    try {
      return addresses().filter((a) => typeof a?.address === 'string');
    } catch {
      return [];
    }
  }

  function safeAllowed() {
    try {
      const list = allowed();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function begin(address, name) {
    const server = makeServer();
    const entry = { server, name, port: null, ok: false, error: null };
    listeners.set(address, entry);
    return new Promise((resolve) => {
      // Kept for the listener's whole life: an error later on marks it, and the next look starts
      // it again, instead of stopping Pleni.
      server.on('error', (err) => {
        entry.ok = false;
        entry.error = err?.code || 'unknown';
        resolve();
      });
      server.listen({ port: port(), host: address }, () => {
        entry.ok = true;
        entry.port = server.address().port;
        resolve();
      });
    });
  }

  function stop(address, entry) {
    listeners.delete(address);
    return new Promise((resolve) => {
      if (!entry.server.listening) return resolve();
      entry.server.close(() => resolve());
      entry.server.closeAllConnections();
    });
  }

  function start() {
    if (closed || timer) return refresh();
    timer = setInterval(() => void refresh(), every);
    timer.unref?.();
    return refresh();
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    timer = null;
    await running.catch(() => {});
    await Promise.all([...listeners].map(([address, entry]) => stop(address, entry)));
  }

  // What Settings shows: { on, addresses: [{ address, name, url, ok, error }], others: [{ address,
  // name }] }, where `others` are this computer's home-network addresses Pleni does not answer on.
  function state() {
    const list = [...listeners].map(([address, e]) => ({
      address,
      name: e.name,
      url: e.ok ? `http://${address}:${e.port}/` : null,
      ok: e.ok,
      error: e.error,
    }));
    const others = safeAddresses().filter((a) => !listeners.has(a.address)).map(({ address, name }) => ({ address, name }));
    return { on: isOn(), addresses: list, others };
  }

  // True while Pleni answers on this address.
  function serving(address) {
    return isOn() && listeners.get(address)?.ok === true;
  }

  return {
    start,
    refresh,
    close,
    state,
    serving,
    // This computer's home-network addresses now, chosen or not: [{ address, name }].
    present: safeAddresses,
    urls: () => state().addresses.filter((a) => a.ok).map((a) => a.url),
  };
}
