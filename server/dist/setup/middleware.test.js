import { describe, it, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import { getLocalSubnetPrefixes, isAllowedOrigin } from './middleware.js';
describe('getLocalSubnetPrefixes', () => {
    it('collects the /24 of every non-internal IPv4 interface', (t) => {
        t.mock.method(os, 'networkInterfaces', () => ({
            eth0: [
                { family: 'IPv4', internal: false, address: '192.168.1.42' },
            ],
            tailscale0: [
                { family: 'IPv4', internal: false, address: '100.64.1.7' },
            ],
            lo: [
                { family: 'IPv4', internal: true, address: '127.0.0.1' },
            ],
        }));
        assert.deepEqual(getLocalSubnetPrefixes(), ['192.168.1.', '100.64.1.']);
        mock.restoreAll();
    });
    it('ignores IPv6 interfaces', (t) => {
        t.mock.method(os, 'networkInterfaces', () => ({
            eth0: [
                { family: 'IPv6', internal: false, address: 'fe80::1' },
            ],
        }));
        assert.deepEqual(getLocalSubnetPrefixes(), []);
        mock.restoreAll();
    });
});
describe('isAllowedOrigin', () => {
    it('rejects hostname and configured-origin prefix impersonation', (t) => {
        t.mock.method(os, 'networkInterfaces', () => ({
            eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }],
        }));
        for (const origin of [
            'http://localhost.attacker.example', 'http://localhost@attacker.example',
            'http://192.168.1.attacker.example', 'http://192.168.1.4.attacker.example',
            'http://localhost:3000/path', 'null', 'file:///etc/passwd',
        ])
            assert.equal(isAllowedOrigin(origin), false, origin);
    });
    it('matches a configured origin exactly, including the port', async (t) => {
        const previous = process.env.ALLOWED_ORIGIN;
        process.env.ALLOWED_ORIGIN = 'https://bed.example:8443';
        t.after(() => {
            if (previous === undefined)
                delete process.env.ALLOWED_ORIGIN;
            else
                process.env.ALLOWED_ORIGIN = previous;
        });
        const { isAllowedOrigin } = await import(`./middleware.js?valid=${Date.now()}`);
        assert.equal(isAllowedOrigin('https://bed.example:8443'), true);
        assert.equal(isAllowedOrigin('https://bed.example:8443.evil.example'), false);
        assert.equal(isAllowedOrigin('https://bed.example:8443@evil.example'), false);
        assert.equal(isAllowedOrigin('https://bed.example:8443/path'), false);
        assert.equal(isAllowedOrigin('https://bed.example'), false);
    });
    it('accepts exact loopback and same-subnet IP origins', (t) => {
        t.mock.method(os, 'networkInterfaces', () => ({
            eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }],
        }));
        for (const origin of ['http://localhost:5173', 'http://127.0.0.1:3000', 'http://192.168.1.20:5173']) {
            assert.equal(isAllowedOrigin(origin), true, origin);
        }
        assert.equal(isAllowedOrigin('http://192.168.6.20:5173'), false);
    });
    it('compares the scheme and host without regard to case', () => {
        assert.equal(isAllowedOrigin('http://LOCALHOST:3000'), true);
        assert.equal(isAllowedOrigin('HTTP://Eight-Pod.LOCAL'), true);
        assert.equal(isAllowedOrigin('http://LOCALHOST:3000/Path'), false);
        assert.equal(isAllowedOrigin('http://LOCALHOST.attacker.example'), false);
    });
    it('accepts the pod\'s mDNS name, with or without a port', () => {
        assert.equal(isAllowedOrigin('http://eight-pod.local:3000'), true);
        assert.equal(isAllowedOrigin('http://eight-pod.local'), true);
    });
    for (const hostname of [
        'eight-pod', 'bed.room.local', 'eight-pod.lan', 'eight-pod.home.arpa', 'eight-pod.internal',
    ]) {
        it(`accepts local hostname ${hostname}`, () => {
            assert.equal(isAllowedOrigin(`http://${hostname}:3000`), true);
            assert.equal(isAllowedOrigin(`https://${hostname}`), true);
        });
    }
    it('refuses public domains and suffix impersonation', () => {
        for (const hostname of ['example.com', 'eight-pod.lan.example.com', 'eight-pod.home.arpa.example.com',
            'eight-pod.internal.example.com', 'eight-pod.ts.net.example.com', 'nots.net', 'eight-pod.home']) {
            assert.equal(isAllowedOrigin(`http://${hostname}:3000`), false, hostname);
        }
    });
    it('accepts a ts.net origin only when it names the host the Pod was reached by', () => {
        assert.equal(isAllowedOrigin('https://eight-pod.tailnet.ts.net', 'eight-pod.tailnet.ts.net'), true);
        assert.equal(isAllowedOrigin('http://eight-pod.tailnet.ts.net:3000', 'EIGHT-POD.tailnet.ts.net:3000'), true);
        assert.equal(isAllowedOrigin('https://site.other-tailnet.ts.net', 'eight-pod.tailnet.ts.net'), false);
        assert.equal(isAllowedOrigin('https://site.other-tailnet.ts.net', '192.168.1.42:3000'), false);
        assert.equal(isAllowedOrigin('https://eight-pod.tailnet.ts.net'), false);
    });
    it('rejects names that only contain .local', () => {
        assert.equal(isAllowedOrigin('http://eight-pod.local.example.com'), false);
        assert.equal(isAllowedOrigin('https://example.com'), false);
        assert.equal(isAllowedOrigin('http://example.com/eight-pod.local'), false);
    });
    it('accepts requests without an Origin header', () => {
        assert.equal(isAllowedOrigin(undefined), true);
    });
});
test('invalid configured origins leave built-in local access available', async (t) => {
    const previous = process.env.ALLOWED_ORIGIN;
    process.env.ALLOWED_ORIGIN = 'eight-pod.tailnet.ts.net';
    t.after(() => {
        if (previous === undefined)
            delete process.env.ALLOWED_ORIGIN;
        else
            process.env.ALLOWED_ORIGIN = previous;
    });
    t.mock.method(os, 'networkInterfaces', () => ({
        eth0: [{ family: 'IPv4', internal: false, address: '192.168.1.42' }],
    }));
    const { isAllowedOrigin: allowed } = await import(`./middleware.js?invalid=${Date.now()}`);
    for (const origin of ['http://localhost:5173', 'http://[::1]:3000', 'http://eight-pod.local', 'http://192.168.1.20']) {
        assert.equal(allowed(origin), true, origin);
    }
});
test('subnet discovery is cached and refreshes after an interface change', async (t) => {
    let now = 1_000;
    let address = '192.168.1.42';
    const interfaces = t.mock.method(os, 'networkInterfaces', () => ({
        eth0: [{ family: 'IPv4', internal: false, address }],
    }));
    t.mock.method(Date, 'now', () => now);
    const { isAllowedOrigin: allowed } = await import(`./middleware.js?subnet-cache=${now}`);
    assert.equal(allowed('http://192.168.1.20'), true);
    assert.equal(allowed('http://192.168.1.20'), true);
    assert.equal(interfaces.mock.callCount(), 1);
    now += 30_000;
    address = '192.168.6.42';
    assert.equal(allowed('http://192.168.6.20'), true);
    assert.equal(allowed('http://192.168.1.20'), false);
    assert.equal(interfaces.mock.callCount(), 2);
});
test('rejected origins are blocked before parsing malformed JSON', async (t) => {
    const { default: express } = await import('express');
    const { default: middleware } = await import('./middleware.js');
    const app = express();
    middleware(app);
    app.post('/example', (_req, res) => { res.sendStatus(204); });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(() => resolve())));
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const response = await fetch(`http://127.0.0.1:${address.port}/example`, {
        method: 'POST', headers: { Origin: 'https://attacker.example', Host: 'attacker.example', 'Content-Type': 'application/json' }, body: '{',
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: 'Origin is not allowed' });
});
test('API bodies that are not JSON are refused with 415, bodiless requests pass', async (t) => {
    const { default: express } = await import('express');
    const { default: middleware } = await import('./middleware.js');
    const app = express();
    middleware(app);
    app.post('/api/example', (req, res) => { res.json({ body: req.body ?? null }); });
    app.put('/api/example', (req, res) => { res.json({ body: req.body ?? null }); });
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(() => resolve())));
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/api/example`;
    const send = (method, headers, body) => fetch(url, { method, headers, body });
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'application/xml', 'multipart/form-data; boundary=x']) {
        const response = await send('POST', { 'Content-Type': type }, '{"left":{}}');
        assert.equal(response.status, 415, type);
    }
    assert.equal((await send('PUT', { 'Content-Type': 'text/plain' }, '{}')).status, 415);
    for (const type of ['application/json', 'application/json; charset=utf-8']) {
        const response = await send('POST', { 'Content-Type': type }, '{"left":{}}');
        assert.equal(response.status, 200, type);
        assert.deepEqual(await response.json(), { body: { left: {} } });
    }
    const bare = await send('POST', {});
    assert.equal(bare.status, 200);
    assert.equal((await send('POST', { 'Content-Type': 'text/plain' }, '')).status, 200);
    const foreign = await send('POST', { Origin: 'https://attacker.example', 'Content-Type': 'text/plain' }, 'x');
    assert.equal(foreign.status, 403);
});
test('settings, schedules and services refuse prototype keys at any depth', async (t) => {
    const { default: express } = await import('express');
    const { default: middleware, hasPrototypeKey } = await import('./middleware.js');
    const app = express();
    middleware(app);
    for (const route of ['/api/settings', '/api/schedules', '/api/services', '/api/rhythms']) {
        app.post(route, (req, res) => { res.json(req.body); });
    }
    const server = app.listen(0, '127.0.0.1');
    t.after(() => new Promise(resolve => server.close(() => resolve())));
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const post = (route, body) => fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    const bodies = [
        '{"__proto__":{"polluted":true}}',
        '{"left":{"scheduleOverrides":{"__proto__":{"polluted":true}}}}',
        '{"left":{"monday":{"constructor":{"prototype":{"polluted":true}}}}}',
        '{"biometrics":{"jobs":{"prototype":1}}}',
        '[{"a":[{"__proto__":1}]}]',
    ];
    for (const route of ['/api/settings', '/api/schedules', '/api/services']) {
        for (const body of bodies)
            assert.equal((await post(route, body)).status, 400, `${route} ${body}`);
        assert.equal((await post(route, '{"left":{"monday":{"power":{"enabled":true}}}}')).status, 200, route);
    }
    // A rhythm named Constructor has the id "constructor".
    const rhythm = '{"left":{"rhythms":{"constructor":{"id":"constructor","name":"Constructor"}}}}';
    assert.equal((await post('/api/rhythms', rhythm)).status, 200);
    const deep = JSON.parse(`${'['.repeat(20000)}{"__proto__":1}${']'.repeat(20000)}`);
    assert.equal(hasPrototypeKey(deep), true);
    assert.equal(hasPrototypeKey({ left: { monday: { temperatures: { '22:00': 70 } } } }), false);
});
//# sourceMappingURL=middleware.test.js.map