# Remote access with Tailscale

By default you can reach the Nightstand web app only from your home Wi-Fi.
[Tailscale](https://tailscale.com) is a third-party service that puts your
phone and the Pod on a private encrypted network (a "tailnet"), so you can
reach the Pod from elsewhere without exposing it to the public internet.
Check its [pricing and eligibility](https://tailscale.com/pricing) before
choosing it.

> These steps come from jmew/free-sleep's install guide, adapted for
> Nightstand's firewall and origin check. I haven't run them on my own Pod,
> so check you can still reach the Pod after each step. I didn't recheck
> Tailscale's own commands, version or console labels either.
> [Tailscale's documentation](https://tailscale.com/docs/) covers those, and
> you can [open an issue here](https://github.com/LTimothy/nightstand/issues)
> about the Nightstand parts.

The web app has no login, and a private tunnel doesn't add one: anyone who
can reach the Pod over Tailscale has the same control as at home
([details](../README.md#what-to-expect)). Limit which tailnet users and
devices can reach the Pod with
[Tailscale's access controls](https://tailscale.com/docs/features/access-control/acls),
and do not expose the app with port forwarding or Tailscale Funnel.

Commands run on the Pod as root over SSH unless a step says otherwise.

## 1. Install Tailscale on the Pod

The Pod needs internet access to download Tailscale. The firewall is probably
on ([installation step 19](../INSTALLATION.md#19-add-firewall-rules-to-limit-internet-access),
a fork switch and every update turn it on) and blocks the download, so turn
it off for now:

```bash
sh /usr/local/lib/nightstand/live/scripts/unblock_internet_access.sh
```

If you stop before step 5, stop Tailscale if you started it (see
[Removing Tailscale](#removing-tailscale)), then turn the firewall back on
with `sh /usr/local/lib/nightstand/live/scripts/block_internet_access.sh`.

Check for the tun device, and set `VERSION` to the newest arm64 version on
[pkgs.tailscale.com](https://pkgs.tailscale.com/stable/#static) (edit that
line):

```bash
# Confirm the kernel exposes /dev/net/tun
ls -la /dev/net/tun || modprobe tun

# Example: the current stable version in October 2026. Check for a newer one.
VERSION=1.102.4
```

Download and check it. If the checksum doesn't match, `exit 1` ends your
shell session before anything is installed; log back in and download again.

```bash
TARBALL=tailscale_${VERSION}_arm64.tgz
cd /tmp
curl -fLO "https://pkgs.tailscale.com/stable/${TARBALL}"
curl -fsSL "https://pkgs.tailscale.com/stable/${TARBALL}.sha256" -o "${TARBALL}.sha256"
[ "$(awk '{print $1}' "${TARBALL}.sha256")" = "$(sha256sum "${TARBALL}" | awk '{print $1}')" ] \
  && echo OK || { echo CHECKSUM_MISMATCH; exit 1; }
```

Install and start it:

```bash
# Binaries on the root file system, state on the persistent partition
mkdir -p /opt/tailscale /persistent/tailscale-state
chmod 0700 /persistent/tailscale-state
tar -C /opt/tailscale --strip-components=1 -xzf "${TARBALL}"
ln -sf /opt/tailscale/tailscale  /usr/sbin/tailscale
ln -sf /opt/tailscale/tailscaled /usr/sbin/tailscaled
rm "${TARBALL}" "${TARBALL}.sha256"

cat > /etc/default/tailscaled <<'EOF'
PORT="41641"
FLAGS=""
EOF

# --statedir is needed as well as --state with a custom state path;
# without it HTTPS certificates fail with "no TailscaleVarRoot".
cat > /etc/systemd/system/tailscaled.service <<'EOF'
[Unit]
Description=Tailscale node agent
Documentation=https://tailscale.com/docs/
Wants=network-pre.target
After=network-pre.target NetworkManager.service systemd-resolved.service

[Service]
EnvironmentFile=/etc/default/tailscaled
ExecStart=/opt/tailscale/tailscaled --statedir=/persistent/tailscale-state --state=/persistent/tailscale-state/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${PORT} $FLAGS
ExecStopPost=/opt/tailscale/tailscaled --cleanup
Restart=on-failure
RuntimeDirectory=tailscale
RuntimeDirectoryMode=0755
CacheDirectory=tailscale
CacheDirectoryMode=0750
Type=notify

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now tailscaled
systemctl status tailscaled   # expect: Active: running, "Needs login:"
```

## 2. Log the Pod in to your tailnet

```bash
tailscale up --hostname=eight-pod --accept-routes=false --advertise-exit-node=false
```

It prints a login URL (`https://login.tailscale.com/a/...`). Open it in any
browser, sign in to Tailscale and approve the device. Then, on the Pod:

```bash
tailscale status     # should show eight-pod with a 100.x.y.z address
```

## 3. Turn on HTTPS and Serve

Two settings in the Tailscale admin console let you reach the Pod at
`https://eight-pod.<tailnet>.ts.net` with no port number. If the labels have
changed, see Tailscale's [Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

1. HTTPS certificates: open <https://login.tailscale.com/admin/dns>, find
   "HTTPS Certificates" and choose Enable HTTPS. This makes the Pod's
   Tailscale hostname and your tailnet name public in certificate logs.
2. Serve: open <https://login.tailscale.com/f/serve> and turn Serve on, or
   follow the link the next command prints if Serve isn't on yet.

Then on the Pod:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:3000
tailscale serve status   # expect: https://eight-pod.<tailnet>.ts.net | -- / proxy http://127.0.0.1:3000
```

Tailscale requests the certificate the first time you open the app. If that
first request fails with an ACME error, wait a few seconds and try again.

Get the full hostname for step 4:

```bash
tailscale status --json | grep DNSName
```

If more than one line appears, use the one that starts with `eight-pod`, and
leave off the trailing dot.

## 4. Allow the Tailscale address in Nightstand

Nightstand accepts browser requests from local addresses and from one exact
extra address you set in `ALLOWED_ORIGIN`, so the Tailscale HTTPS hostname
needs adding. This checks where a browser request comes from (its Origin
header). It isn't a login, and requests with no Origin header, from outside
a browser, are accepted.

Run this once, while the bed is empty and no alarm is due, since it restarts
Nightstand. Each run adds another line, so if you typed the wrong host, edit
that line in the service file instead of running `sed` again.

```bash
# Replace with the hostname from step 3
TS_HOST="eight-pod.<your-tailnet>.ts.net"
sed -i "/^Environment=NODE_ENV=production/a Environment=ALLOWED_ORIGIN=https://${TS_HOST}" /etc/systemd/system/free-sleep.service
grep ALLOWED_ORIGIN /etc/systemd/system/free-sleep.service   # expect one line
systemctl daemon-reload
systemctl restart free-sleep
```

In-app updates keep this setting. Rerunning the installer from
[installation step 13](../INSTALLATION.md#13-install-the-nightstand-server)
rewrites the service file, so repeat this step if you do that.

## 5. Turn the firewall back on

The firewall script adds Tailscale's exceptions only if Tailscale is running
when it runs. Check that `tailscale status` works, then:

```bash
sh /usr/local/lib/nightstand/live/scripts/block_internet_access.sh
```

It should print `tailscaled active: allowing its control-plane/DERP/STUN egress`.
If it says `tailscaled inactive`, start Tailscale and run it again.

With Tailscale running, the rules (see them with `iptables -L OUTPUT -n -v`)
also allow all traffic on the `tailscale0` interface, which carries the
connection to your phone, plus outbound DNS (port 53), UDP (for direct
WireGuard connections and STUN) and TCP 443 (for Tailscale's servers and
relays) to any host. These exceptions are broad: the Pod can reach any HTTPS
server, Eight Sleep's included. Masking the update services in
[installation step 11](../INSTALLATION.md#11-disable-software-updates) still
stops firmware updates. The exceptions stay until the firewall is applied
again, even if Tailscale stops. To remove them, stop Tailscale and rerun the
script.

## 6. Use the Pod from your phone

1. Install Tailscale on your phone
   ([App Store](https://apps.apple.com/us/app/tailscale/id1470499037) or
   [Play Store](https://play.google.com/store/apps/details?id=com.tailscale.ipn))
   and sign in to the same account.
2. Open `https://eight-pod.<tailnet>.ts.net` in the phone's browser.
3. Add it to your home screen as in
   [installation step 16](../INSTALLATION.md#16-save-the-web-app-to-your-home-screen).
4. Leave Tailscale on. Unless you set up an exit node, only traffic to your
   tailnet goes through it.

## 7. Check it works

From a device that isn't on your home Wi-Fi (on a phone, turn off Wi-Fi):

- `https://eight-pod.<tailnet>.ts.net` should load the app with live data.
- On the Pod, `tailscale status` should list both the Pod and your phone,
  shown as `direct` or relayed. Either works.

To check that it survives a restart, run this on your computer while the bed
is empty, then test again from your phone after a few minutes. The app
should load without logging in again. That shows only that the server
answered, not that heating, cooling or alarms work.

```bash
ssh -p 8822 root@<POD_IP> reboot
```

## Removing Tailscale

On the Pod, stop Tailscale, take the address back out of Nightstand and apply
the firewall without Tailscale's exceptions. The block script should print
`tailscaled inactive`. Do this from a local connection, while the bed is
empty. I haven't run these commands on a Pod yet.

```bash
systemctl disable --now tailscaled
sed -i '/^Environment=ALLOWED_ORIGIN=/d' /etc/systemd/system/free-sleep.service
systemctl daemon-reload
systemctl restart free-sleep
sh /usr/local/lib/nightstand/live/scripts/block_internet_access.sh
```

Then remove the Pod from your tailnet in the Tailscale admin console. The
files from step 1 can stay or be deleted.
