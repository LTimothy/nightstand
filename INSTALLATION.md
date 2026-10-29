# Installing Nightstand

This guide installs Nightstand from scratch: you open the Pod, connect a
serial cable to its board, get a root shell and run the installer (a Pod 3
with an SD card skips the cable). If your Pod already runs a free-sleep fork,
use [Coming from free-sleep](docs/COMING_FROM_FREE_SLEEP.md#switching)
instead; you only need [step 20](#20-remote-access-with-tailscale-optional)
here, for remote access.

> Steps 1 to 12 come from upstream free-sleep's install guide. I have only a
> Pod 5, so I haven't tried the Pod 3 and Pod 4 parts (the SD card method,
> the teardown and the firmware reset), and they may be out of date. Ask
> [upstream free-sleep](https://github.com/throwaway31265/free-sleep) about
> those. For Pod 5 questions, or anything from step 13 on,
> [open an issue here](https://github.com/LTimothy/nightstand/issues).
> I followed upstream's version of steps 1 to 12 on my Pod 5 for my own first
> install.

## Before you start

Nightstand is unofficial, so read
[Before you install](README.md#before-you-install) in the README first. A
first install has no earlier Nightstand to fall back to: if it fails,
recovery needs the serial cable or SSH.

- Pod 3 with an SD card: get a root shell with the SD card method in
  [Compatibility](#compatibility), then join at
  [step 11](#11-disable-software-updates). No cable or tools needed.
- Pod 3 without an SD card, Pod 4 or Pod 5: you open the Pod and connect a
  cable to its circuit board. Get the tools below, then start at
  [step 1](#1-access-the-circuit-board). On a Pod 5 there are no teardown or
  board photos here yet, so read step 1 before you open it.

Also read [Going back to the Eight Sleep app](#going-back-to-the-eight-sleep-app)
for your model. On a Pod 5 there is no tested way back.

## Compatibility

- Pod 1 and Pod 2: not compatible.
- Pod 3 with an SD card: supported by upstream free-sleep. The SD card method
  needs a Linux computer. Get root with blopker's
  [ZeroSleep guide](https://blopker.com/writing/04-zerosleep-1/) or
  Pixel-Meister's [SD card script](https://github.com/Pixel-Meister/freesleep_script/blob/main/modify_eight_sleep.sh).
  Once you can SSH in as root, do [step 11](#11-disable-software-updates)
  right away. Then skip step 12 (the Pod is already on your network) and
  continue from step 13.
  Some prebuilt free-sleep SD images contain shared root and rewt passwords
  and an EyePhone Wi-Fi profile that auto-joins a hotspot with a shared key,
  as reported in [GoogleBot42's podd research](https://github.com/GoogleBot42/podd/blob/main/docs/research/connectivity-and-diff.md).
  If you used a prebuilt image, also set your own passwords with `passwd root`
  and `passwd rewt`, as in [step 7](#7-set-the-root-and-rewt-passwords).
  The installer checks for the reported password salt and a possibly inherited
  EyePhone profile. The profile check matches its path, connection ID, type and
  SSID, without comparing the key or autoconnect setting. A custom EyePhone
  profile with your own key and autoconnect disabled can also match. Review the
  profile before removing it. The installer offers to remove each profile and
  change each affected account's password, only after a separate yes. A
  non-interactive run warns and changes neither. Keep your SSH session open
  and configure your own Wi-Fi before
  removing EyePhone. To run the check later, use
  `bash /usr/local/lib/nightstand/live/scripts/check_image_credentials.sh` as root.
- Pod 3 without an SD card (FCC ID 2AYXT61100001, printed on the back of the
  Pod where the water tubes plug in) and Pod 4: supported by upstream
  free-sleep.
- Pod 5: the model I use and test on.

> [!CAUTION]
> Some Pod 5 units on newer firmware have a locked bootloader that blocks
> installation at step 4. Units kept offline before the update are not affected.
> See [issue #6](https://github.com/LTimothy/nightstand/issues/6) for the
> current state.

- Pod 6: unknown.

## Tools required

These are for the cable method only. The cable connects your computer to the
board's serial console (UART), which lets you stop the boot and get a root
shell.

- [TC2070-IDC ($50)](https://www.tag-connect.com/product/tc2070-idc): a
  Tag-Connect cable whose spring pins press onto pads on the board, so there's
  nothing to solder. If you'd rather solder, attach the three required wires
  to the JTAG header instead.
- [FTDI FT232RL ($13)](https://www.amazon.com/gp/product/B07TXVRQ7V/): a
  USB-to-serial adapter.
- [Dupont wires ($7)](https://www.amazon.com/Elegoo-EL-CP-004-Multicolored-Breadboard-arduino/dp/B01EV70C78):
  jumper wires to connect the cable to the adapter.

You'll also need an SSH key pair on your computer for
[step 18](#18-add-an-ssh-config). If you don't have one, `ssh-keygen` creates
it. These steps are written for Mac and Linux; on Windows you'll need to adapt
them yourself.

## Installation steps

Steps 1 to 4 are physical setup or commands on your computer. From step 5,
commands run on the Pod, first through the serial console and later over SSH.

### 1. Access the circuit board

1. Pod 5 only: set up your Pod with the Eight Sleep app first, then continue.
2. Unplug the Pod, then follow the teardown steps for your model:
   - [Pod 3](docs/pod_3_teardown)
   - [Pod 4](docs/pod_4_teardown) ([written instructions](docs/pod_4_teardown/instructions.md))
   - Pod 5: no teardown or board photos here yet. If you're unsure how to
     open it or where the cable goes,
     [open an issue](https://github.com/LTimothy/nightstand/issues) before you
     start. Photos from yours would be welcome in a pull request.

### 2. Connect to the device

1. Keep the Pod unplugged from power and from the mattress cover.
2. Set the FTDI adapter's voltage jumper to 3.3V before connecting anything
   ([photo](docs/jtag/4_module_connection.png)). The board's serial pins run
   at 3.3V, and the 5V setting can damage them. Then connect the Tag-Connect
   cable to the adapter with Dupont wires, following the images in
   [docs/jtag/](docs/jtag/).
3. Connect the Tag-Connect cable to the circuit board:
   - [Pod 3](docs/pod_3_teardown/7_pod_3_board_connection.jpeg)
   - [Pod 4](docs/pod_4_teardown/2_circuit_board.png)
   - Pod 5: no photo yet. Don't guess at the pads (see step 1).
4. Plug the FTDI adapter into your computer.

### 3. Get minicom ready on your computer

minicom is a terminal program for serial devices. Install it with
`brew install minicom` (Mac) or `sudo apt install minicom` (Debian/Ubuntu).

Find the adapter's device name: run `ls /dev/tty*`, unplug the adapter, run
it again, then plug it back in. The entry that disappeared is the adapter. On
a Mac it looks like `/dev/tty.usbserial-B0010NHK`; on Linux it's usually
`/dev/ttyUSB0`. Put your device's name in this command (the baud rate is
921600):

```bash
minicom -b 921600 -o -D /dev/tty.usbserial-B0010NHK
```

minicom should open to a screen like this one, taken on a Mac. If it can't
open the device, check the name again.

![minicom](docs/installation/0_minicom.png)

### 4. Plug the power into the Pod

> [!CAUTION]
> Some Pod 5 units on newer firmware do not show `Hit any key to stop autoboot`
> and boot straight through. If yours does, **stop here**. There is no software
> workaround yet. See [issue #6](https://github.com/LTimothy/nightstand/issues/6)
> for the current state.

Plug in the Pod's power and watch minicom. When `Hit any key to stop autoboot`
appears, press a key (Ctrl+C works). If you miss it and the Pod keeps booting,
unplug the power and try again.

![Interrupt](docs/installation/1_interrupt.png)

If the Pod's output appears but your key presses do nothing, a common cause is
minicom's hardware flow control. Press Ctrl+A, then O, open "Serial port
setup", and set Hardware Flow Control to No.

If it worked, you'll see this prompt:

![Interrupt success](docs/installation/2_shell.png)

### 5. Modify the boot environment

These commands tell the Pod to boot once into a root shell. The change isn't
saved, so the reboot in step 9 goes back to a normal boot.

First check which slot the Pod boots from. Type this at the bootloader prompt:

```text
printenv current_slot
```

If it prints `current_slot=a`, type these two lines:

```text
setenv bootargs "root=PARTLABEL=rootfs_a rootwait init=/bin/bash"
run bootcmd
```

If it prints anything else, stop, and don't substitute another partition
name. On a Pod 3 or Pod 4, reset the firmware (see
[Going back to the Eight Sleep app](#going-back-to-the-eight-sleep-app)) and
start again. If it still isn't `a`, open an issue. On a Pod 5, which has no
tested firmware reset yet, open an issue without going further.

### 6. Mount the file system

You're now in a minimal root shell with nothing mounted. These commands mount
the system folders and make the root file system writable, so type carefully
from here on.

```bash
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mount -t tmpfs tmpfs /run
mount -o remount,rw /
```

### 7. Set the root and rewt passwords

The Pod has two accounts with full access, root and rewt. Set a password on
each; you'll log in as root in step 10. Keep a record of the password: without
it or an SSH key, the only way back in is the cable.

```bash
passwd root
passwd rewt
```

### 8. Sync the file changes

This writes your changes to disk before the reboot.

```bash
sync
```

### 9. Reboot

Do not interrupt this boot or press any keys in minicom until the login
prompt appears.

```bash
reboot -f
```

### 10. Log in as root with the password you set

On Pod 4 and Pod 5 the prompt looks slightly different from this screenshot.

![Login](docs/installation/3_login.png)

### 11. Disable software updates

Do this as soon as you're logged in, whichever way you got in. Until you do,
the Pod can update its firmware on its own and lock you out.

These commands stop Eight Sleep's update and telemetry services, keep them
from starting at boot, and mask them so nothing else can start them. Not
every Pod has all of these services, so errors saying a unit isn't loaded or
doesn't exist are expected.

```bash
# First save which of these are enabled, so they can be restored later
[ -e /persistent/nightstand-stock/unit-states.txt ] || { mkdir -p /persistent/nightstand-stock && for unit in swupdate-progress swupdate defibrillator eight-kernel telegraf vector frankenfirmware dac swupdate.socket; do echo "$unit $(systemctl is-enabled $unit 2>/dev/null || echo unknown)"; done > /persistent/nightstand-stock/unit-states.txt; }
systemctl disable --now swupdate-progress swupdate defibrillator eight-kernel telegraf vector frankenfirmware dac swupdate.socket
systemctl mask swupdate-progress swupdate defibrillator eight-kernel telegraf vector frankenfirmware dac swupdate.socket
```

### 12. Set up internet access

This connects the Pod to your Wi-Fi. Pod 3 with an SD card: skip this step.

Replace `WIFI_NAME` (it appears twice) and `PASSWORD` with your network's name
and password. Use your regular network rather than a guest network. Upstream's
guide says not to use one, alongside other ways of keeping the Pod off the
internet, without giving a further reason. The Pod needs internet access for
the next step; step 19 limits it afterward. The later steps also assume the
Pod, your computer and your phone share a normal home network.

```bash
nmcli connection add type wifi con-name WIFI_NAME ifname wlan0 ssid WIFI_NAME wifi-sec.key-mgmt wpa-psk wifi-sec.psk "PASSWORD" ipv4.method auto ipv6.method auto
nmcli connection reload
```

Optional: to stop the blinking blue "waiting to be set up" light, copy the
Wi-Fi profiles, then change their ID and reload:

```bash
cp -a /persistent/system-connections /persistent/system-connections.stock
sed -i 's/uuid=.*/uuid=700a7a76-2105-4f46-b1b4-c9f3c791c440/' /persistent/system-connections/*.nmconnection
nmcli connection reload
```

### 13. Install the Nightstand server

Download the installer so you can read it first, then run it:

```bash
curl -fsSL https://raw.githubusercontent.com/LTimothy/nightstand/main/scripts/install.sh -o /tmp/nightstand-install.sh
bash /tmp/nightstand-install.sh
```

It prints your dac.sock path, then `Installation complete!`. If that path
doesn't end in `dac.sock`, open an issue before going further, and read any
warnings above that line. On a Pod 5, wait about another minute for the
prompt to come back while it tries the watchdog (below).

The installer downloads the newest Nightstand release, which may be a beta,
checks it against its published checksum when one exists, installs it, and
sets Nightstand to start on boot. Nightstand is also restarted if it stops
answering for 3 minutes, except during an install, reset, update, rollback
or fork switch.
The checksum catches a corrupted download.
On a first install the check comes from the same download, so it can't catch
a swapped one. An update from 3.5.1 or earlier to 3.6.0 is not checked,
because those versions have no checksum step. After 3.6.0 is installed,
updates with a published checksum are checked by the installed copy.
Neither catches a compromised GitHub account. It saves the
release's channel as the Pod's update channel, which later updates and
reinstalls follow; to follow stable releases, choose Stable in Settings >
Software. Run over an existing install, it keeps that install as the
rollback copy and checks the new server up to 30 times, waiting 3 seconds
before each request with a 5-second timeout (roughly 4 minutes plus overhead
in the worst case). Until that check passes, a failure or interruption
puts the previous install back unless Nightstand or the stream won't stop,
in which case manual recovery is needed. The installer holds the operation
lock through this check and any restore, and refuses to run while another
install, reset, update, rollback or fork switch holds it.

After a power loss during an update swap, Nightstand makes one recovery
attempt 45 seconds after boot. It keeps a healthy live install or tries to
restore the marked previous version. A timeout or failed restore needs
manual recovery ([details and limits](ops/ANTIBRICK.md#what-is-backed-up-and-checked)).
On my Pod 5, a reboot with no marker did nothing, a hand-set marker cleared
after the health check, and a power cut shortly after the server stopped
for an update left the previous install healthy and the marker cleared.
A cut during the tree move itself is covered only by automated tests.
Nightstand keeps free-sleep's folder and service names, so you'll see
`free-sleep` in paths and commands.

If something goes wrong:

- A certificate error: check the Pod's clock with `date`. A clock that is far
  off breaks HTTPS.
- "older than this installer supports": run the command again with
  `NIGHTSTAND_CHANNEL=beta` in front of it. That also changes the saved
  channel to beta.

On a Pod 5 the installer then sets the hardware watchdog to restart the Pod
after about 30 seconds if its system freezes. It tries the setting for about
a minute first. If the trial fails, the watchdog stays off and later updates
don't try again. A failure the script can't catch restarts the Pod once.
Other models are left as they are for now. I checked setup, removal,
persistence across a reboot and recovery from a deliberate freeze on my
Pod 5.

With the watchdog on, and where the Pod uses the stock MT7663 Wi-Fi driver
(my Pod 5 does), a timer also checks the network every minute. If that
driver has crashed this boot and the network has been down for 5 minutes, or
the network has been down for 20 minutes with Wi-Fi scans failing throughout,
it restarts the Pod: at most once in 6 hours and three times a day, never in
the first 10 minutes after boot or during an install, update, rollback, reset
or fork switch. Whether a restart brings Wi-Fi back isn't confirmed yet.

To turn the watchdog off, run
`bash /usr/local/lib/nightstand/live/scripts/setup_watchdog.sh --remove`. It stays off
through updates and reinstalls until you run the same command without
`--remove`. On some Pods it turns off only at the next restart.

### 14. Get your Pod's IP address

```bash
nmcli -g ip4.address device show wlan0
```

It prints something like this. The Pod's IP address is the part before `/24`.

```text
192.168.1.50/24
```

### 15. Open the Nightstand web app

From a phone or computer on the same Wi-Fi network as the Pod, open the Pod's
IP address on port 3000. With the example address above, that's
`http://192.168.1.50:3000/`.

The web app has no login: any device that can reach the Pod can control it,
read its sleep data and change its software
([details](README.md#what-to-expect)). Use a trusted local network, do not
port-forward it to the public internet, and restrict access if you set up
Tailscale.

Set your time zone under Settings > Bed and sides before using schedules. The
app looks dimmed until the Pod is connected to the mattress cover. That is
expected.

![Web App](docs/installation/4_web_app.png)

### 16. Save the web app to your home screen

- iPhone and iPad: open the app in Safari, tap the share icon, then "Add to
  Home Screen".
- Android: open the app in Chrome, tap the three-dot menu, then "Add to Home
  screen" (sometimes shown as "Install app").

### 17. Check that Nightstand starts on boot

1. Unplug the Pod's power and plug it back in.
2. Wait up to about four minutes, then open the app from another device.
3. If it loads (dimmed until the cover is connected, as in step 15),
   Nightstand starts on boot as it should. That shows only that the server
   answered; heating and cooling are checked in
   [Before you close the Pod](#before-you-close-the-pod).
4. Log in again in minicom as in step 10 (Pod 3 with an SD card: over SSH).

### 18. Add an SSH config

This lets you reach the Pod over the network instead of the cable. The script:

- replaces the Pod's SSH server and client configuration, with SSH on port
  8822 and password login for root still allowed;
- deletes the existing keys in `/etc/ssh/authorized_keys`;
- asks you to paste one public key, which it saves in
  `/home/root/ssh/authorized_keys`. Paste the contents of the file ending in
  `.pub` (such as `~/.ssh/id_ed25519.pub`), never the one without it.

```bash
sh /usr/local/lib/nightstand/live/scripts/setup_ssh.sh
```

Afterward, connect with `ssh root@<POD_IP> -p 8822`. If you're running this
over SSH rather than the cable (Pod 3 with an SD card), the port or key you
used to get in may stop working, so keep your current session open until a
new connection on port 8822 works.

### 19. Add firewall rules to limit internet access

Without these rules, Eight Sleep's firmware can reach the internet and upload
its raw sensor recordings. With them, most internet access is blocked. Time
sync still works, and name lookups go only to the resolvers your network had
set when the script ran (it prints them; rerun it after moving the Pod to
another network). HTTPS and UDP to any server stay open while Tailscale runs.

Local access keeps working on a private network, which most home networks
are: the Pod's address from step 14 should start with `10.`, `192.168.`, or
`172.16.` through `172.31.`. If it doesn't, these rules can cut off the app
and SSH, leaving the cable as the only way back in.

Run this on the Pod:

```bash
sh /usr/local/lib/nightstand/live/scripts/block_internet_access.sh
```

To undo the rules:

```bash
sh /usr/local/lib/nightstand/live/scripts/unblock_internet_access.sh
```

Undoing them lasts until the next reboot, when the saved rules load again, or
until the next update, rollback, fork switch or Biometrics install, which
apply the rules again. Nightstand has no setting to keep them off.

Updates open only HTTPS and name lookups while they download, then apply
these rules even if you skipped this step. The Biometrics install lifts the
rules only while it downloads. If you start or stop Tailscale
later, run the block script again
([details](docs/REMOTE_ACCESS.md#5-turn-the-firewall-back-on)). Masking the
update services in step 11 stops firmware updates; the firewall is a second
layer.

### 20. Remote access with Tailscale (optional)

[Remote access with Tailscale](docs/REMOTE_ACCESS.md) covers installing
Tailscale on the Pod, HTTPS, and limiting who can reach it. Start Tailscale
before you rerun the step 19 script.

## Before you close the Pod

Pod 3 with an SD card: skip steps 2 and 3.

1. From your computer, check that `ssh root@<POD_IP> -p 8822` works and the
   web app loads. If either fails, fix it while the cable is still connected.
2. Unplug the power, then disconnect the Tag-Connect cable.
3. Put the case back together (Pod 4:
   [putting it back together](docs/pod_4_teardown/instructions.md#putting-it-back-together)).
4. Connect the Pod to the cover as you normally would, with nobody on the bed.
5. In the web app, set one side to the highest temperature and the other to
   the lowest.
6. Check that the temperature actually changes, by hand or with a thermometer,
   then turn both sides off.
7. If it doesn't, open an issue with your Pod model, Nightstand version and
   what you saw. Output of [`fs-debug`](#nightstand-shortcuts) can help.

That's the install. Biometrics (sleep tracking) is off by default; the
[README](README.md#biometrics) covers turning it on.

## Going back to the Eight Sleep app

These are upstream's steps for returning to the Eight Sleep app. I haven't
tried them after a Nightstand install on any model. Going back to an earlier
Nightstand release or to upstream free-sleep is covered in
[Coming from free-sleep](docs/COMING_FROM_FREE_SLEEP.md#going-back).

First copy any data you want to keep to your computer, for example with
`scp -r -P 8822 root@<POD_IP>:/persistent/free-sleep-data ./pod-data`.
I haven't run this exact command against a Pod.

1. If the Pod is still on your Eight Sleep account, open the app, manage the
   Pod and remove it from your account.
2. Reset the firmware:
   - [Pod 3](docs/pod_3_teardown/6_firmware_reset.jpeg)
   - [Pod 4](docs/pod_4_teardown/3_reset_firmware.png)
   - Pod 5: Eight Sleep's support page gives the same reset for Pod 2 through
     Pod 5: hold the small button on the back of the hub while you plug it in,
     release when the light blinks green, and wait for blue. I expect it to
     work, but I haven't tried it after an install and haven't found anyone
     who has. If the Pod stops booting, the serial cable is the only known
     way back in. Do not try to go back by re-enabling the services step 11
     turned off: that lets the Pod update its firmware, which can remove the
     root access you set up, and I haven't tried it.
     [What installation changes on the Pod](#what-installation-changes-on-the-pod)
     lists each change and how to undo it.
3. Set up the Pod as a new Pod in the app. It may then update its firmware on
   its own. That is expected.

## What installation changes on the Pod

Install and update warn if root cron contains legacy jobs that open the
firewall, without changing the crontab. The fork-switch tool asks before
removing those jobs, their time sync script and the ambient-light service.
It backs up removed files, stops unknown `free-sleep*` units before the database
checkpoint and does not enable them afterward. It reports IPv6-disable settings
without changing them. See [Coming from free-sleep](docs/COMING_FROM_FREE_SLEEP.md#what-changes)
for consent and recovery details.

Nightstand never replaces Eight Sleep's programs. It changes these system
settings, and since 3.6.0 it saves them the first time it changes them,
in /persistent/nightstand-stock/. Check `recorded.txt` before restoring:
it says whether each copy is the original or was taken after Nightstand
had already changed it. A copy marked `after-nightstand` does not bring
back Eight Sleep's settings.

A saved item can be a marker: `NAME.absent` means the file did not exist,
and `NAME.link` records a symlink whose target was missing. A symlink with
a readable target is saved as a copy of that target. To restore a file,
copy it back if there is a copy, remove the replacement if there is an
`.absent` marker, or recreate the symlink to the target in `.link`.

| Change | Made by | Original saved as | How to undo |
| --- | --- | --- | --- |
| Eight Sleep's update and cloud services disabled and masked | step 11 | `unit-states.txt` | `systemctl unmask` and `systemctl enable` each unit listed as enabled there. Doing this lets the Pod update its firmware, which can remove root access. |
| SSH server config, client config, keys and service replaced | step 18 (`setup_ssh.sh`) | `sshd_config`, `ssh_config`, `authorized_keys`, `sshd.service` | Restore the first three under /etc/ssh/ and `sshd.service` under /etc/systemd/system/ as described above, run `systemctl daemon-reload` and restart sshd. Step 18 removed /etc/ssh/authorized_keys and put your key in /home/root/ssh/authorized_keys. Keep a working SSH session open while you do. |
| Firewall rules replaced | step 19 (`block_internet_access.sh`) | `iptables.rules` and `ip6tables.rules` are live snapshots from `iptables-save` and `ip6tables-save`; `*.rules.file` saves the rules files from /etc/iptables/ | Use `iptables-restore` and `ip6tables-restore` with the live snapshots. Restore the rules files under /etc/iptables/ from `*.rules.file` or their markers as described above. |
| Time sync servers changed | step 19 | `timesyncd.conf` | Restore it under /etc/systemd/ as described above and restart systemd-timesyncd. |
| Wi-Fi profile UUIDs rewritten | step 12 | `/persistent/system-connections.stock/` (only if you made the copy in step 12) | Copy the files back to /persistent/system-connections/ and restart NetworkManager. |
| Hardware watchdog enabled where the script's Pod 5 checks pass | step 13 (`setup_watchdog.sh`) | not needed | Before removing /home/dac/free-sleep, run `bash /usr/local/lib/nightstand/live/scripts/setup_watchdog.sh --remove` as root. It removes /etc/systemd/system.conf.d/10-nightstand-watchdog.conf and the trial copy under /run/systemd/system.conf.d/, and leaves a note so later installs and updates keep it off. If the kernel cannot stop the running watchdog, or systemd cannot reload the setting, it turns off only after a restart. |
| Nightstand's services, timers, sudoers rules and memory limits added | step 13 | not needed | Stop and disable Nightstand's services and timers before removing the free-sleep units and their drop-ins under /etc/systemd/system/, /etc/sudoers.d/dac and /home/dac/free-sleep. Run `systemctl daemon-reload` after removing the units. |

On Pod 5, undoing all of this has not been tried, and there is no checked
firmware reset, so treat these steps as information, not a tested way back.

## Nightstand shortcuts

Step 13 installs these. Run them on the Pod as root, over SSH or at the serial
console.

- `fs-debug`: prints device and server status, resolver configuration and
  service logs. Check it before sharing and remove personal or network
  details you don't want public.
- `fs-restart`: stops and starts the free-sleep service, and starts the
  free-sleep-stream service only if Biometrics is on in the app; otherwise it
  leaves the stream stopped and disabled.
- `fs-reset-db`: saves a copy of the biometrics database in
  `/persistent/free-sleep-database-backups`, then deletes the database and
  creates it empty. A damaged database is copied as it is. Asks for
  confirmation first.
- `fs-reset`: permanently deletes Nightstand's settings, schedules and sleep
  data in `/persistent/free-sleep-data/`, then restarts Nightstand with empty
  settings and Biometrics off, so the stream stays stopped. If Nightstand or
  the stream won't stop, it deletes nothing. It keeps the backups in
  `/persistent/free-sleep-backups` and `/persistent/free-sleep-database-backups`
  and the firmware's own raw recordings in `/persistent`, which the archive
  can pick up again; delete the backups too to remove all sleep data. Asks
  for confirmation first.
- `fs-update`: selects the newest release allowed by your saved channel and
  uses the same backup and rollback steps as the app. Stable selects stable
  releases; beta includes both channels. To choose a channel or a specific
  version, use Settings > Software. If a side is on, an alarm is due within
  15 minutes, or the bed's state can't be read, the app asks before going
  ahead. If the app didn't need to ask, it checks again just before
  Nightstand stops, and the update ends with nothing changed if the bed has
  come into use since. `fs-update` itself doesn't check, so run it with both
  sides off and no alarm due.
