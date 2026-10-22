import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createLan, homeAddresses, isHomeAddress, isIPv4 } from '../src/lan.js';

test('an IPv4 address has four parts of 0 to 255', () => {
  for (const ip of ['0.0.0.0', '192.168.1.23', '255.255.255.255']) assert.equal(isIPv4(ip), true, ip);
  for (const ip of ['256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.x', ' 1.2.3.4', '::1', '', null, 5]) assert.equal(isIPv4(ip), false, String(ip));
});

test('only home-network addresses count: 10.x, 172.16-31.x and 192.168.x', () => {
  for (const ip of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.1', '192.168.0.1', '192.168.86.23']) {
    assert.equal(isHomeAddress(ip), true, ip);
  }
  for (const ip of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '172.15.0.1', '172.32.0.1', '192.169.0.1', '100.64.0.7', '169.254.10.1', '192.168.1.256', '10.1.1', 'fe80::1', '', null]) {
    assert.equal(isHomeAddress(ip), false, String(ip));
  }
});

test('the Wi-Fi addresses leave out loopback, IPv6, public and Tailscale addresses, likeliest first', () => {
  const interfaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    'vEthernet (WSL)': [{ address: '172.24.16.1', family: 'IPv4', internal: false }],
    Ethernet: [{ address: '10.0.0.5', family: 'IPv4', internal: false }],
    'Wi-Fi': [
      { address: 'fe80::1c2b:3a4d', family: 'IPv6', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
    'VirtualBox Host-Only Network': [{ address: '192.168.56.1', family: 'IPv4', internal: false }],
    Tailscale: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
    'Public adapter': [{ address: '203.0.113.9', family: 'IPv4', internal: false }],
    // Node 18.0 to 18.3 gave the family as a number.
    eth9: [{ address: '192.168.1.40', family: 4, internal: false }],
    copy: [{ address: '192.168.1.23', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(homeAddresses(interfaces), [
    { address: '192.168.1.23', name: 'Wi-Fi' },
    { address: '192.168.1.40', name: 'eth9' },
    { address: '192.168.56.1', name: 'VirtualBox Host-Only Network' },
    { address: '10.0.0.5', name: 'Ethernet' },
    { address: '172.24.16.1', name: 'vEthernet (WSL)' },
  ]);
  assert.deepEqual(homeAddresses({}), []);
  assert.deepEqual(homeAddresses(null), []);
});

// `chosen` is the list of addresses the person chose; by default every address offered.
function lanFor(t, { on = true, addresses, chosen = null, makeServer } = {}) {
  const state = { on, chosen };
  const lan = createLan({
    makeServer: makeServer ?? (() => http.createServer((req, res) => res.end('hi'))),
    isOn: () => state.on,
    allowed: () => state.chosen ?? addresses().map((a) => a.address),
    port: () => 0,
    addresses,
  });
  t.after(() => lan.close());
  return { lan, state };
}

test('listeners start and stop with the switch, and a failed address is tried again later', async (t) => {
  const list = [{ address: '127.0.0.1', name: 'Wi-Fi' }];
  const { lan, state } = lanFor(t, { addresses: () => list });
  await lan.start();
  const [first] = lan.state().addresses;
  assert.equal(first.ok, true);
  assert.equal(lan.serving('127.0.0.1'), true);
  assert.deepEqual(lan.urls(), [first.url]);
  // An address this computer does not have fails to listen; Settings shows why.
  list.push({ address: '192.0.2.1', name: 'Gone' });
  await lan.refresh();
  const failed = lan.state().addresses.find((a) => a.address === '192.0.2.1');
  assert.equal(failed.ok, false);
  assert.equal(typeof failed.error, 'string');
  assert.equal(lan.serving('192.0.2.1'), false);
  list.pop();
  await lan.refresh();
  assert.deepEqual(lan.state().addresses.map((a) => a.address), ['127.0.0.1']);
  state.on = false;
  assert.equal(lan.serving('127.0.0.1'), false, 'off at once, before the listener closes');
  await lan.refresh();
  assert.deepEqual(lan.state(), { on: false, addresses: [], others: [{ address: '127.0.0.1', name: 'Wi-Fi' }] });
});

test('Pleni listens only on the addresses the person chose; the others are listed for Settings', async (t) => {
  const list = [{ address: '127.0.0.1', name: 'Wi-Fi' }, { address: '192.0.2.1', name: 'Hotel Wi-Fi' }];
  const { lan, state } = lanFor(t, { addresses: () => list, chosen: ['192.0.2.99'] });
  await lan.start();
  // A chosen address this computer does not have now is not listened on, and nothing else is.
  assert.deepEqual(lan.state().addresses, []);
  assert.deepEqual(lan.state().others, list);
  assert.deepEqual(lan.present(), list);
  state.chosen = ['192.0.2.99', '127.0.0.1'];
  await lan.refresh();
  assert.deepEqual(lan.state().addresses.map((a) => [a.address, a.ok]), [['127.0.0.1', true]]);
  assert.deepEqual(lan.state().others, [{ address: '192.0.2.1', name: 'Hotel Wi-Fi' }]);
});

test('an error after a listener started does not stop Pleni; the next look starts it again', async (t) => {
  const servers = [];
  const make = () => {
    const server = http.createServer((req, res) => res.end('hi'));
    servers.push(server);
    return server;
  };
  const { lan } = lanFor(t, { addresses: () => [{ address: '127.0.0.1', name: 'Wi-Fi' }], makeServer: make });
  await lan.start();
  servers[0].emit('error', Object.assign(new Error('too many open files'), { code: 'EMFILE' }));
  servers[0].emit('error', Object.assign(new Error('again'), { code: 'EMFILE' }));
  assert.deepEqual(lan.state().addresses.map((a) => [a.ok, a.error]), [[false, 'EMFILE']]);
  await lan.refresh();
  assert.equal(servers.length, 2);
  assert.equal(servers[0].listening, false);
  assert.deepEqual(lan.state().addresses.map((a) => [a.ok, a.error]), [[true, null]]);
});

test('a broken address list does not stop Pleni', async (t) => {
  const { lan } = lanFor(t, { addresses: () => { throw new Error('no network'); }, chosen: ['192.168.1.23'] });
  await lan.start();
  assert.deepEqual(lan.state(), { on: true, addresses: [], others: [] });
});

test('after close, nothing listens and nothing starts again', async (t) => {
  const { lan } = lanFor(t, { addresses: () => [{ address: '127.0.0.1', name: 'Wi-Fi' }] });
  await lan.start();
  const url = lan.urls()[0];
  await lan.close();
  await lan.refresh();
  assert.deepEqual(lan.state().addresses, []);
  await assert.rejects(get(url), { code: 'ECONNREFUSED' });
});

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (res) => {
      res.resume();
      res.on('end', resolve);
    }).on('error', reject);
  });
}
