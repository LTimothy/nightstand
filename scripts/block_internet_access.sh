#!/bin/bash

echo "Blocking internet access..."

# Upstream resolvers as "4 ADDR" or "6 ADDR" lines. Local stubs (127.0.0.53,
# 127.0.0.1) are skipped because loopback is already allowed, so the real
# upstream list systemd-resolved keeps is read as well.
list_wan_resolvers() {
  set --
  for file in /etc/resolv.conf /run/systemd/resolve/resolv.conf; do
    [ -r "$file" ] && set -- "$@" "$file"
  done
  [ $# -gt 0 ] || return 0
  awk '
    function ipv4(address, octets, count, partIndex) {
      count = split(address, octets, ".")
      if (count != 4) return 0
      for (partIndex = 1; partIndex <= count; partIndex++)
        if (octets[partIndex] !~ /^[0-9]+$/ || length(octets[partIndex]) > 3 || octets[partIndex] + 0 > 255) return 0
      return 1
    }
    function groups(address, parts, count, partIndex) {
      if (address == "") return 0
      count = split(address, parts, ":")
      for (partIndex = 1; partIndex <= count; partIndex++)
        if (parts[partIndex] !~ /^[0-9a-f]+$/ || length(parts[partIndex]) > 4) return -1
      return count
    }
    function ipv6(address, halves, count, left, right, tail) {
      if (address ~ /[.]/) {
        tail = address
        sub(/^.*:/, "", tail)
        if (!ipv4(tail)) return 0
        sub(/[0-9.]+$/, "0:0", address)
      }
      count = split(address, halves, "::")
      if (count == 1) return groups(address) == 8
      if (count != 2) return 0
      left = groups(halves[1]); right = groups(halves[2])
      return left >= 0 && right >= 0 && left + right < 8
    }
    $1 == "nameserver" {
      resolver = tolower($2)
      # An IPv4-mapped address leaves as IPv4, so treat it as one.
      if (resolver ~ /^::ffff:[0-9.]+$/) sub(/^::ffff:/, "", resolver)
      if (ipv4(resolver)) {
        family = 4
        split(resolver, octets, ".")
        if (octets[1] == 127 || octets[1] == 10 ||
            (octets[1] == 172 && octets[2] >= 16 && octets[2] <= 31) ||
            (octets[1] == 192 && octets[2] == 168) || resolver == "0.0.0.0") next
      } else if (ipv6(resolver)) {
        family = 6
        if (resolver ~ /^fe[89ab]/ || resolver ~ /^fd/ ||
            resolver ~ /^(0*:)*0*1$/ || resolver ~ /^[0:]+$/) next
      } else next
      if (!seen[resolver]++) print family, resolver
    }
  ' "$@"
}

WAN_RESOLVERS=$(list_wan_resolvers)
if [ -n "$WAN_RESOLVERS" ]; then
  echo "Allowing DNS to resolvers: $(echo "$WAN_RESOLVERS" | awk '{ printf "%s%s", sep, $2; sep = " " }')"
else
  echo "No WAN DNS resolver found in /etc/resolv.conf or /run/systemd/resolve/resolv.conf; DNS stays blocked"
fi

# Resolver rules are added separately, after each address family's flush.
allow_dns_to_configured_resolvers() {
  echo "$WAN_RESOLVERS" | while read -r family resolver; do
    [ "$family" = "$1" ] || continue
    if [ "$1" = 4 ]; then
      iptables -A OUTPUT -d "$resolver" -p udp --dport 53 -j ACCEPT
      iptables -A OUTPUT -d "$resolver" -p tcp --dport 53 -j ACCEPT
    else
      ip6tables -A OUTPUT -d "$resolver" -p udp --dport 53 -j ACCEPT
      ip6tables -A OUTPUT -d "$resolver" -p tcp --dport 53 -j ACCEPT
    fi
  done
}

# Keep a terminal block even when the kernel cannot install REJECT rules.
install_drop_tail() {
  echo "WARNING: $1 REJECT tail unavailable; falling back to DROP" >&2
  if "$1" -A OUTPUT -j DROP && "$1" -C OUTPUT -j DROP; then
    return 0
  fi
  "$1" -P OUTPUT DROP || true
  echo "ERROR: could not verify $1 OUTPUT tail; rules will not be saved" >&2
  return 1
}

verify_output_tail() {
  "$1" -C OUTPUT -j REJECT 2>/dev/null || "$1" -C OUTPUT -j DROP 2>/dev/null || install_drop_tail "$1"
}

FIREWALL_FAILED=no

EIGHT_SLEEP_HOSTS="update-api.8slp.net raw-api-upload.8slp.net device-api-ws.8slp.net"
HOSTS_FILE=/etc/hosts

# Rewrites only the marked block. cat > keeps /etc/hosts a symlink if it is one.
block_stock_update_hosts() {
  local host merged
  merged=$(mktemp) || return 1
  {
    # A start marker with no end marker keeps its following lines.
    awk '
      /^# nightstand-block-start$/ {skip = 1; held = ""; next}
      /^# nightstand-block-end$/ && skip {skip = 0; held = ""; next}
      skip {held = held $0 "\n"; next}
      {print}
      END {printf "%s", held}
    ' "$HOSTS_FILE"
    echo "# nightstand-block-start"
    for host in $EIGHT_SLEEP_HOSTS; do
      echo "0.0.0.0 $host"
      echo ":: $host"
    done
    echo "# nightstand-block-end"
  } > "$merged" && cat "$merged" > "$HOSTS_FILE"
  local status=$?
  rm -f "$merged"
  return $status
}

block_stock_update_hosts || echo "Warning: could not update $HOSTS_FILE" >&2
systemctl mask swupdate-usb@.service 2>/dev/null || true

# IPv4 Rules
echo "Configuring IPv4 rules..."

# Keep the original rules and time sync settings before the first change.
bash "$(dirname "$0")/record_stock.sh" firewall 2>/dev/null || true

# Start from a clean slate so the saved ruleset is exactly what this script
# writes. Otherwise every re-run stacks duplicates, and stale ACCEPT rules above
# the final REJECT survive and get saved at the bottom.
iptables -F INPUT
iptables -F OUTPUT

# -----------------------------------------------------------------------------------------------------
# Allow return traffic for connections this pod initiates (DNS answers,
# TCP 443 responses). The outbound allows further down only open the forward
# direction; without these conntrack rules the INPUT DROP at the end would
# eat the responses. Unconditional: this is core firewall plumbing, not
# specific to any one allowed destination below.
iptables -C INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
iptables -I INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -C OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
iptables -I OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# -----------------------------------------------------------------------------------------------------

# Allow LAN traffic Class A (10.0.0.0/8)
iptables -A INPUT -s 10.0.0.0/8 -j ACCEPT
iptables -A OUTPUT -d 10.0.0.0/8 -j ACCEPT

# Allow LAN traffic Class B (172.16.0.0/12)
iptables -A INPUT -s 172.16.0.0/12 -j ACCEPT
iptables -A OUTPUT -d 172.16.0.0/12 -j ACCEPT

# Allow LAN traffic Class C (192.168.0.0/16)
iptables -A INPUT -s 192.168.0.0/16 -j ACCEPT
iptables -A OUTPUT -d 192.168.0.0/16 -j ACCEPT

allow_dns_to_configured_resolvers 4

# Allow NTP traffic - this allows us to synchronize the system time
iptables -I OUTPUT -p udp --dport 123 -j ACCEPT

echo "Updating the timesyncd config"
# New configuration content
cat > /etc/systemd/timesyncd.conf <<EOF
[Time]
NTP=pool.ntp.org 0.pool.ntp.org 1.pool.ntp.org 2.pool.ntp.org 3.pool.ntp.org
FallbackNTP=time1.google.com time2.google.com time3.google.com time4.google.com
RootDistanceMaxSec=5
PollIntervalMinSec=32
PollIntervalMaxSec=2048
EOF

# Restart timesyncd to apply changes
systemctl restart systemd-timesyncd


# Allow localhost (loopback) traffic so local apps can talk to each other
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

# Let avahi answer mDNS queries so eight-pod.local resolves on the LAN.
iptables -A OUTPUT -d 224.0.0.251 -p udp --dport 5353 -j ACCEPT

# -----------------------------------------------------------------------------------------------------
# Allow Tailscale (https://tailscale.com/kb/1082/firewall-ports)
#
# Tailscale gives us remote access to the pod from outside the LAN without
# exposing it to the public internet. Without these rules, the final OUTPUT
# reject below would block tailscaled from reaching its control plane and DERP relays.
#
# (1) Anything on the tailscale interface: the VPN payload between the user's
#     devices and this pod (e.g., phone browser -> https://eight-pod).
iptables -A INPUT  -i tailscale0 -j ACCEPT
iptables -A OUTPUT -o tailscale0 -j ACCEPT

# (2) tailscaled needs outbound to talk to peers + Tailscale's control plane:
#       - UDP everywhere: direct WireGuard peer connections + STUN
#       - TCP/443: control plane (controlplane.tailscale.com) + DERP relays
#       - DNS: to resolve controlplane.tailscale.com / derp*.tailscale.com
#     These also let the pod reach any HTTPS host, Eight Sleep's cloud
#     included, so they are added only while tailscaled is running. If you set
#     up Tailscale later, re-run this script once it is active. Eight Sleep's
#     OTA updates are also blocked at the systemd level (services masked per
#     INSTALLATION.md); this firewall is a second layer.
if systemctl is-active --quiet tailscaled; then
  echo "tailscaled active: allowing its control-plane/DERP/STUN egress"
  iptables -A OUTPUT -p udp -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 443 -j ACCEPT
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
else
  echo "tailscaled inactive: skipping its WAN egress rules (full block)"
fi
# -----------------------------------------------------------------------------------------------------

# Reset the firmware's cloud connection instead of dropping it. Some firmware
# blocks on a dropped connection, and an ICMP reject does not end one already open.
iptables -A OUTPUT -p tcp --dport 1337 -j REJECT --reject-with tcp-reset

# Reject blocked outbound connections so firmware does not wait for timeouts.
iptables -A INPUT -j DROP || FIREWALL_FAILED=yes
if ! {
  iptables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset &&
  iptables -A OUTPUT -p udp -j REJECT --reject-with icmp-port-unreachable &&
  iptables -A OUTPUT -j REJECT
}; then
  install_drop_tail iptables || FIREWALL_FAILED=yes
fi

echo "Configuring IPv6 rules..."
ip6tables -F INPUT
ip6tables -F OUTPUT
# DNS replies use the same return-traffic rule as IPv4.
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
# Allow local traffic for IPv6
ip6tables -A INPUT -s fe80::/10 -j ACCEPT
ip6tables -A OUTPUT -d fe80::/10 -j ACCEPT
ip6tables -A INPUT -s fd00::/8 -j ACCEPT
ip6tables -A OUTPUT -d fd00::/8 -j ACCEPT

# Discovery includes unicast replies and probes from :: during address checks.
# Hop limit 255 keeps these four message types on the local link.
for discovery_type in 133 134 135 136; do
  ip6tables -A INPUT -p ipv6-icmp --icmpv6-type "$discovery_type" -m hl --hl-eq 255 -j ACCEPT
  ip6tables -A OUTPUT -p ipv6-icmp --icmpv6-type "$discovery_type" -m hl --hl-eq 255 -j ACCEPT
done

allow_dns_to_configured_resolvers 6

# Allow NTP traffic (IPv6)
ip6tables -I OUTPUT -p udp --dport 123 -j ACCEPT

ip6tables -A OUTPUT -d ff02::fb -p udp --dport 5353 -j ACCEPT

# Block everything else (IPv6)
ip6tables -A INPUT -j DROP || FIREWALL_FAILED=yes
if ! {
  ip6tables -A OUTPUT -p tcp -j REJECT --reject-with tcp-reset &&
  ip6tables -A OUTPUT -p udp -j REJECT --reject-with icmp6-port-unreachable &&
  ip6tables -A OUTPUT -j REJECT
}; then
  install_drop_tail ip6tables || FIREWALL_FAILED=yes
fi
verify_output_tail iptables || FIREWALL_FAILED=yes
verify_output_tail ip6tables || FIREWALL_FAILED=yes
iptables -C INPUT -j DROP || FIREWALL_FAILED=yes
ip6tables -C INPUT -j DROP || FIREWALL_FAILED=yes
[ "$FIREWALL_FAILED" = no ] || exit 1

# A verified tail keeps WAN blocked while clearing the emergency policy.
iptables -P OUTPUT ACCEPT || FIREWALL_FAILED=yes
ip6tables -P OUTPUT ACCEPT || FIREWALL_FAILED=yes
if [ "$FIREWALL_FAILED" = yes ]; then
  echo "ERROR: could not restore OUTPUT policies; rules will not be saved" >&2
  exit 1
fi

# Save only after both families have verified terminal blocks.
if ! iptables-save > /etc/iptables/iptables.rules ||
   ! ip6tables-save > /etc/iptables/ip6tables.rules; then
  echo "ERROR: could not save firewall rules" >&2
  exit 1
fi

echo "Blocked WAN internet access successfully!"

