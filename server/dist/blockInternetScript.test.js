import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BlockList } from 'node:net';
import { fileURLToPath } from 'node:url';
// block_internet_access.sh runs as root on the pod and saves its result, so
// structural checks are supplemented with fake commands and redirected files.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(repoRoot, 'scripts/block_internet_access.sh');
const src = readFileSync(SCRIPT, 'utf8');
// Runs the script against stub firewall commands and redirected resolver
// files, and returns the logged rules and the script's output.
function runBlock(resolvConf, tailscale, resolved, faults = {}) {
    const folder = mkdtempSync(path.join(tmpdir(), 'nightstand-dns-firewall-'));
    try {
        writeFileSync(path.join(folder, 'resolv.conf'), resolvConf);
        if (resolved !== undefined)
            writeFileSync(path.join(folder, 'resolved.conf'), resolved);
        for (const tool of ['iptables', 'ip6tables', 'iptables-save', 'ip6tables-save', 'systemctl']) {
            const body = tool === 'systemctl'
                ? `#!/bin/sh\ncase "$*" in *is-active*tailscaled*) exit ${tailscale ? 0 : 1} ;; esac\n`
                : `#!/bin/bash
echo "${tool} $*" >> "$ATTEMPT_LOG"
if [ "$1" = -C ]; then
grep -Fxq -- "${tool} -A \${*:2}" "$RULE_LOG" || grep -Fxq -- "${tool} -I \${*:2}" "$RULE_LOG"
exit $?
fi
case " $FAIL_REJECT " in
*" ${tool} "*)
  if [[ "$*" == *"-j REJECT"* ]] && { [ "$FAIL_REJECT_KIND" = all ] || [[ "$*" == "$FAIL_REJECT_KIND" ]]; }; then exit 1; fi ;;
esac
case " $FAIL_DROP " in *" ${tool} "*) [[ "$*" == *"OUTPUT -j DROP" ]] && exit 1 ;; esac
case " $IGNORE_DROP " in *" ${tool} "*) [[ "$*" == *"OUTPUT -j DROP" ]] && exit 0 ;; esac
echo "${tool} $*" >> "$RULE_LOG"
`;
            const file = path.join(folder, tool);
            writeFileSync(file, body);
            chmodSync(file, 0o755);
        }
        const script = src.replaceAll('/etc/resolv.conf', path.join(folder, 'resolv.conf'))
            .replaceAll('/run/systemd/resolve/resolv.conf', path.join(folder, 'resolved.conf'))
            .replaceAll('/etc/systemd/timesyncd.conf', path.join(folder, 'timesyncd.conf'))
            .replaceAll('/etc/iptables/', `${folder}/`);
        const result = spawnSync('sh', ['-c', script], {
            encoding: 'utf8',
            env: { ...process.env, PATH: `${folder}:${process.env.PATH}`, RULE_LOG: path.join(folder, 'rules'),
                ATTEMPT_LOG: path.join(folder, 'attempts'), FAIL_REJECT_KIND: 'all', ...faults },
        });
        return { lines: readFileSync(path.join(folder, 'rules'), 'utf8').trim().split('\n'),
            attempts: readFileSync(path.join(folder, 'attempts'), 'utf8'), status: result.status, output: result.stdout, error: result.stderr };
    }
    finally {
        rmSync(folder, { recursive: true, force: true });
    }
}
describe('block_internet_access.sh', () => {
    it('parses', () => {
        assert.doesNotThrow(() => execFileSync('bash', ['-n', SCRIPT]));
    });
    it('flushes each chain before adding rules, so re-runs do not stack them', () => {
        for (const tool of ['iptables', 'ip6tables']) {
            const firstAppend = src.search(new RegExp(`^${tool} -A`, 'm'));
            for (const chain of ['INPUT', 'OUTPUT']) {
                const flush = src.indexOf(`${tool} -F ${chain}`);
                assert.ok(flush !== -1, `${tool} never flushes ${chain}`);
                assert.ok(flush < firstAppend, `${tool} flushes ${chain} after it starts adding rules`);
            }
        }
    });
    it('opens outbound UDP and HTTPS only while tailscaled is running', () => {
        const gate = src.indexOf('if systemctl is-active --quiet tailscaled; then');
        const end = src.indexOf('\nfi', gate);
        assert.ok(gate !== -1 && end !== -1, 'no tailscaled gate');
        for (const rule of ['iptables -A OUTPUT -p udp -j ACCEPT', 'iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT']) {
            const at = src.indexOf(rule);
            assert.ok(at > gate && at < end, `"${rule}" is outside the tailscaled gate`);
            assert.equal(src.indexOf(rule, at + 1), -1, `"${rule}" appears more than once`);
        }
    });
    it('resets the firmware cloud connection before the final rejects', () => {
        const reset = src.indexOf('iptables -A OUTPUT -p tcp --dport 1337 -j REJECT --reject-with tcp-reset');
        const reject = src.indexOf('iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset');
        const save = src.indexOf('iptables-save');
        assert.ok(reset !== -1, 'no tcp-reset rule for port 1337');
        assert.ok(reset < reject && reject < save, 'reset rule must come before the final rejects and the save');
    });
    it('ends OUTPUT with rejects when supported and keeps INPUT on DROP', () => {
        const { lines, status } = runBlock('', false);
        assert.equal(status, 0);
        for (const [tool, udp] of [['iptables', 'icmp-port-unreachable'], ['ip6tables', 'icmp6-port-unreachable']]) {
            assert.deepEqual(lines.filter(line => line.startsWith(`${tool} -A OUTPUT `)).slice(-3), [
                `${tool} -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset`,
                `${tool} -A OUTPUT -p udp -j REJECT --reject-with ${udp}`,
                `${tool} -A OUTPUT -j REJECT`,
            ]);
            assert.ok(lines.includes(`${tool} -A INPUT -j DROP`));
        }
    });
    it('keeps every allow ahead of the final rejects', () => {
        const firstReject = src.indexOf('iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset');
        for (const allow of [
            'iptables -I OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
            'iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT',
            'iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT',
            'iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT',
            'iptables -I OUTPUT -p udp --dport 123 -j ACCEPT',
            'iptables -A OUTPUT -o lo -j ACCEPT',
            'iptables -A OUTPUT -o tailscale0 -j ACCEPT',
            'iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT',
            'iptables -A OUTPUT -p tcp --dport 1337 -j REJECT --reject-with tcp-reset',
        ]) {
            const at = src.indexOf(allow);
            assert.ok(at !== -1, `missing "${allow}"`);
            assert.ok(at < firstReject, `"${allow}" must come before the final rejects`);
        }
    });
    it('accepts IPv6 loopback so local reject replies are delivered', () => {
        const firstReject = src.indexOf('ip6tables -A OUTPUT -p tcp -j REJECT');
        for (const rule of ['ip6tables -A INPUT -i lo -j ACCEPT', 'ip6tables -A OUTPUT -o lo -j ACCEPT']) {
            const at = src.indexOf(rule);
            assert.ok(at !== -1 && at < firstReject, `"${rule}" missing or after the rejects`);
        }
    });
    it('lets mDNS answers out so eight-pod.local keeps resolving without Tailscale', () => {
        const gate = src.indexOf('if systemctl is-active --quiet tailscaled; then');
        const gateEnd = src.indexOf('\nfi', gate);
        for (const [rule, reject] of [
            ['iptables -A OUTPUT -d 224.0.0.251 -p udp --dport 5353 -j ACCEPT', 'iptables -A OUTPUT -p tcp -j REJECT'],
            ['ip6tables -A OUTPUT -d ff02::fb -p udp --dport 5353 -j ACCEPT', 'ip6tables -A OUTPUT -p tcp -j REJECT'],
        ]) {
            const at = src.indexOf(rule);
            assert.ok(at !== -1, `missing "${rule}"`);
            assert.ok(at < gate || at > gateEnd, `"${rule}" must not depend on tailscaled`);
            assert.ok(at < src.indexOf(reject), `"${rule}" must come before "${reject}"`);
        }
    });
    it('keeps the original rules and time sync settings before changing either', () => {
        const record = src.indexOf('bash "$(dirname "$0")/record_stock.sh" firewall 2>/dev/null || true');
        assert.ok(record !== -1, 'never records the originals');
        assert.ok(record < src.indexOf('iptables -F INPUT'), 'records after the first flush');
        assert.ok(record < src.indexOf('cat > /etc/systemd/timesyncd.conf'), 'records after time sync is rewritten');
    });
    it('still saves both rulesets', () => {
        assert.match(src, /iptables-save > \/etc\/iptables\/iptables\.rules/);
        assert.match(src, /ip6tables-save > \/etc\/iptables\/ip6tables\.rules/);
    });
    for (const [label, failed] of [
        ['IPv4', 'iptables'], ['IPv6', 'ip6tables'], ['both families', 'iptables ip6tables'],
    ]) {
        it(`falls back to verified DROP when REJECT fails for ${label}`, () => {
            const { lines, attempts, status, output } = runBlock('', false, undefined, { FAIL_REJECT: failed });
            assert.equal(status, 0);
            assert.match(output, /Blocked WAN internet access successfully/);
            for (const tool of ['iptables', 'ip6tables']) {
                const target = failed.split(' ').includes(tool) ? 'DROP' : 'REJECT';
                assert.ok(lines.includes(`${tool} -A OUTPUT -j ${target}`));
                assert.ok(attempts.includes(`${tool} -C OUTPUT -j ${target}`));
                assert.ok(attempts.indexOf(`${tool} -C OUTPUT -j ${target}`) < attempts.indexOf('iptables-save'));
            }
        });
    }
    for (const [tool, udp] of [['iptables', 'icmp-port-unreachable'], ['ip6tables', 'icmp6-port-unreachable']]) {
        for (const kind of ['-A OUTPUT -p tcp -j REJECT --reject-with tcp-reset',
            `-A OUTPUT -p udp -j REJECT --reject-with ${udp}`, '-A OUTPUT -j REJECT']) {
            it(`falls back to DROP when the ${tool} REJECT tail partially fails at ${kind}`, () => {
                const { lines, status } = runBlock('', false, undefined, { FAIL_REJECT: tool, FAIL_REJECT_KIND: kind });
                assert.equal(status, 0);
                assert.ok(lines.includes(`${tool} -A OUTPUT -j DROP`));
            });
        }
    }
    for (const [label, failed] of [
        ['IPv4', 'iptables'], ['IPv6', 'ip6tables'], ['both families', 'iptables ip6tables'],
    ]) {
        for (const failure of ['installation', 'verification']) {
            it(`refuses to save or report success when ${label} DROP ${failure} fails`, () => {
                const faults = failure === 'installation' ? { FAIL_DROP: failed } : { IGNORE_DROP: failed };
                const { lines, attempts, status, output } = runBlock('', false, undefined, { FAIL_REJECT: failed, ...faults });
                assert.notEqual(status, 0);
                assert.doesNotMatch(output, /successfully/);
                assert.ok(!lines.some(line => line.startsWith('iptables-save') || line.startsWith('ip6tables-save')));
                for (const tool of ['iptables', 'ip6tables']) {
                    if (failed.split(' ').includes(tool)) {
                        assert.ok(attempts.includes(`${tool} -P OUTPUT DROP`));
                    }
                    else {
                        assert.ok(lines.includes(`${tool} -A OUTPUT -j REJECT`), `${tool} must still be secured`);
                    }
                }
            });
        }
    }
    function discoveryAccepts(lines, packet) {
        return lines.filter(line => line.startsWith(`ip6tables -A ${packet.chain} `) && line.includes('-p ipv6-icmp')).some(line => {
            const args = line.split(' ');
            const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
            const addressMatches = (flag, address) => {
                const subnet = value(flag);
                if (!subnet)
                    return true;
                const [prefix, bits = '128'] = subnet.split('/');
                const block = new BlockList();
                block.addSubnet(prefix, Number(bits), 'ipv6');
                return block.check(address, 'ipv6');
            };
            return value('-j') === 'ACCEPT' && value('--icmpv6-type') === String(packet.type)
                && value('--hl-eq') === String(packet.hopLimit)
                && addressMatches('-s', packet.source) && addressMatches('-d', packet.destination);
        });
    }
    let discoveryRules;
    function installedDiscoveryRules() {
        if (!discoveryRules) {
            const result = runBlock('', false);
            assert.equal(result.status, 0, result.error);
            discoveryRules = result.lines;
        }
        return discoveryRules;
    }
    for (const chain of ['INPUT', 'OUTPUT']) {
        for (const [label, source, destination, type] of [
            ['multicast router solicitation', '::', 'ff02::2', 133],
            ['multicast router advertisement', 'fe80::1', 'ff02::1', 134],
            ['unicast router advertisement', 'fe80::1', '2001:db8::2', 134],
            ['multicast neighbor solicitation', '2001:db8::2', 'ff02::1:ff00:1', 135],
            ['duplicate address detection', '::', 'ff02::1:ff00:1', 135],
            ['unicast neighbor solicitation', '2001:db8::2', '2001:db8::1', 135],
            ['solicited unicast neighbor advertisement', '2001:db8::1', '2001:db8::2', 136],
            ['duplicate address advertisement', '2001:db8::1', 'ff02::1', 136],
        ]) {
            it(`allows ${chain} ${label} with hop limit 255`, () => {
                const lines = installedDiscoveryRules();
                assert.ok(discoveryAccepts(lines, { chain, source, destination, type, hopLimit: 255 }));
            });
        }
        it(`limits ${chain} discovery to types 133 through 136 and hop limit 255`, () => {
            const lines = installedDiscoveryRules();
            const packet = { chain, source: '2001:db8::1', destination: '2001:db8::2', type: 136, hopLimit: 255 };
            for (const hopLimit of [1, 64, 254])
                assert.equal(discoveryAccepts(lines, { ...packet, hopLimit }), false);
            for (const type of [128, 129, 132, 137])
                assert.equal(discoveryAccepts(lines, { ...packet, type }), false);
            for (const rule of lines.filter(line => line.startsWith(`ip6tables -A ${chain} `) && line.includes('-p ipv6-icmp'))) {
                assert.ok(lines.indexOf(rule) > lines.indexOf(`ip6tables -F ${chain}`));
                assert.ok(lines.indexOf(rule) < lines.indexOf(`ip6tables -A ${chain} -j ${chain === 'INPUT' ? 'DROP' : 'REJECT'}`));
            }
        });
    }
    for (const tailscale of [false, true]) {
        it(`applies final outbound rejects and inbound drops with Tailscale ${tailscale ? 'on' : 'off'}`, () => {
            const { lines } = runBlock('nameserver 9.9.9.9', tailscale);
            for (const [tool, udpReject] of [['iptables', 'icmp-port-unreachable'], ['ip6tables', 'icmp6-port-unreachable']]) {
                const output = lines.filter(line => line.startsWith(`${tool} -A OUTPUT `));
                assert.deepEqual(output.slice(-3), [
                    `${tool} -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset`,
                    `${tool} -A OUTPUT -p udp -j REJECT --reject-with ${udpReject}`,
                    `${tool} -A OUTPUT -j REJECT`,
                ]);
                assert.ok(lines.includes(`${tool} -A INPUT -j DROP`));
                assert.ok(lines.indexOf(output[output.length - 1]) < lines.findIndex(line => line.startsWith(`${tool}-save`)));
            }
        });
    }
    const wanDnsRules = (lines, tool) => lines.filter(line => line.startsWith(`${tool} -A OUTPUT -d`) && line.includes('--dport 53 '));
    for (const tailscale of [false, true]) {
        it(`allows only configured WAN resolvers after both flushes${tailscale ? ' with Tailscale' : ''}`, () => {
            const { lines, output } = runBlock([
                'nameserver 9.9.9.9',
                'nameserver 2606:4700:4700::1111',
                'nameserver 2606:4700:4700::1111',
                'nameserver ::ffff:8.8.8.8',
                'nameserver ::ffff:127.0.0.1',
                'nameserver 127.0.0.53',
                'nameserver 10.0.0.1',
                'nameserver 172.16.0.1',
                'nameserver 172.31.255.254',
                'nameserver 192.168.0.1',
                'nameserver ::1',
                'nameserver 0:0:0:0:0:0:0:1',
                'nameserver fe80::1%eth0',
                'nameserver fd12::1',
                'nameserver invalid.example',
                'nameserver 999.1.1.1',
                'nameserver 9.9.9.9/0',
                'nameserver 2606:zzzz::1',
                'nameserver ::',
                'search example.org',
                'nameserver 8.8.4.4',
            ].join('\n'), tailscale);
            assert.deepEqual(output.split('\n').filter(line => line.includes('Allowing DNS')), ['Allowing DNS to resolvers: 9.9.9.9 2606:4700:4700::1111 8.8.8.8 8.8.4.4']);
            for (const [tool, resolvers] of [
                ['iptables', ['9.9.9.9', '8.8.8.8', '8.8.4.4']],
                ['ip6tables', ['2606:4700:4700::1111']],
            ]) {
                const dns = wanDnsRules(lines, tool);
                assert.deepEqual(dns, resolvers.flatMap(resolver => ['udp', 'tcp'].map(protocol => `${tool} -A OUTPUT -d ${resolver} -p ${protocol} --dport 53 -j ACCEPT`)));
                for (const rule of dns) {
                    assert.ok(lines.indexOf(rule) > lines.indexOf(`${tool} -F OUTPUT`));
                    assert.ok(lines.indexOf(rule) < lines.indexOf(`${tool} -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset`));
                }
                assert.ok(lines.includes(`${tool} -I OUTPUT -p udp --dport 123 -j ACCEPT`));
                assert.ok(lines.some(line => line.startsWith(`${tool} -`)
                    && line.includes('INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT')));
                const accepts = lines.filter(line => new RegExp(`^${tool} -[AI] OUTPUT `).test(line) && line.endsWith('-j ACCEPT'));
                const tailscaleRules = tool === 'iptables' && tailscale ? [
                    'iptables -A OUTPUT -p udp -j ACCEPT',
                    'iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT',
                    'iptables -A OUTPUT -p udp --dport 53 -j ACCEPT',
                    'iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT',
                ] : [];
                assert.deepEqual(accepts, tool === 'iptables' ? [
                    'iptables -I OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT',
                    'iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT',
                    'iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT',
                    'iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT',
                    ...dns,
                    'iptables -I OUTPUT -p udp --dport 123 -j ACCEPT',
                    'iptables -A OUTPUT -o lo -j ACCEPT',
                    'iptables -A OUTPUT -d 224.0.0.251 -p udp --dport 5353 -j ACCEPT',
                    'iptables -A OUTPUT -o tailscale0 -j ACCEPT',
                    ...tailscaleRules,
                ] : [
                    'ip6tables -A OUTPUT -o lo -j ACCEPT',
                    'ip6tables -A OUTPUT -d fe80::/10 -j ACCEPT',
                    'ip6tables -A OUTPUT -d fd00::/8 -j ACCEPT',
                    ...[133, 134, 135, 136].map(type => `ip6tables -A OUTPUT -p ipv6-icmp --icmpv6-type ${type} -m hl --hl-eq 255 -j ACCEPT`),
                    ...dns,
                    'ip6tables -I OUTPUT -p udp --dport 123 -j ACCEPT',
                    'ip6tables -A OUTPUT -d ff02::fb -p udp --dport 5353 -j ACCEPT',
                ], 'no other outbound allowance');
                assert.equal(lines.filter(line => line.startsWith(`${tool} -A INPUT`) && line.includes('--sport 53')).length, 0);
            }
        });
    }
    it('finds the upstream resolvers behind a systemd-resolved stub', () => {
        const { lines, output } = runBlock('nameserver 127.0.0.53\noptions edns0\n', false, '# resolved upstream list\nnameserver 192.168.1.1\nnameserver 1.1.1.1\nnameserver 2606:4700:4700::1001\n');
        assert.deepEqual(wanDnsRules(lines, 'iptables'), [
            'iptables -A OUTPUT -d 1.1.1.1 -p udp --dport 53 -j ACCEPT',
            'iptables -A OUTPUT -d 1.1.1.1 -p tcp --dport 53 -j ACCEPT',
        ]);
        assert.deepEqual(wanDnsRules(lines, 'ip6tables'), [
            'ip6tables -A OUTPUT -d 2606:4700:4700::1001 -p udp --dport 53 -j ACCEPT',
            'ip6tables -A OUTPUT -d 2606:4700:4700::1001 -p tcp --dport 53 -j ACCEPT',
        ]);
        assert.match(output, /^Allowing DNS to resolvers: 1\.1\.1\.1 2606:4700:4700::1001$/m);
    });
    it('merges both resolver files without repeating an address', () => {
        const { lines, output } = runBlock('nameserver 9.9.9.9\n', false, 'nameserver 127.0.0.53\nnameserver 9.9.9.9\nnameserver 8.8.8.8\n');
        assert.deepEqual(wanDnsRules(lines, 'iptables').filter(rule => rule.includes('-p udp')), [
            'iptables -A OUTPUT -d 9.9.9.9 -p udp --dport 53 -j ACCEPT',
            'iptables -A OUTPUT -d 8.8.8.8 -p udp --dport 53 -j ACCEPT',
        ]);
        assert.match(output, /^Allowing DNS to resolvers: 9\.9\.9\.9 8\.8\.8\.8$/m);
    });
    for (const [name, resolvConf, resolved] of [
        ['a systemd-resolved stub with no upstream list', 'nameserver 127.0.0.53\n', undefined],
        ['a dnsmasq stub', 'nameserver 127.0.0.1\nnameserver ::1\n', undefined],
        ['stubs and LAN resolvers only', 'nameserver 127.0.0.53\n', 'nameserver 192.168.1.1\nnameserver fe80::1%eth0\n'],
        ['an empty resolv.conf', '', undefined],
    ]) {
        it(`says so when ${name} leaves no WAN resolver`, () => {
            const { lines, output } = runBlock(resolvConf, false, resolved);
            assert.equal(wanDnsRules(lines, 'iptables').length, 0);
            assert.equal(wanDnsRules(lines, 'ip6tables').length, 0);
            assert.match(output, /^No WAN DNS resolver found in .*; DNS stays blocked$/m);
            assert.ok(lines.includes('iptables -A OUTPUT -j REJECT'));
        });
    }
});
//# sourceMappingURL=blockInternetScript.test.js.map