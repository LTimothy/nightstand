# Metrics retention

Settings > Features > Storage has two independent switches, checked daily
even when Biometrics is off:

- Low-disk protection is on by default. It runs only below 150 MiB available
  on the data filesystem (`/persistent` on a Pod). It deletes the oldest
  detailed vitals first, in timestamp order, in transactions of at most
  1,000 rows. Each batch rechecks filesystem space and SQLite reusable pages.
  Each transaction has a three-second timeout. A timed-out batch rolls back
  its summary writes and deletions, logs the stop reason once, and ends that
  daily run. Previously committed batches remain committed.
  It stops when the filesystem is healthy, reusable pages reach 16 MiB,
  no eligible rows can be deleted, or 100 batches have run. A later daily
  check can continue. It retains at least 48 hours of detail and each side's
  two latest recorded nights, including nights before a long absence. It
  does not prune a prefix of a night that overlaps that protected window.
- Prune detail after 30 days is off by default and requires opt-in. It
  deletes only detailed vitals older than 30 days, with the same protected
  recent nights and bounded transactions.

Neither switch deletes nightly summaries, sleep records, scores or movement.
Before a night's first detail deletion, the transaction writes its complete
vitals summary to the additive `vitals_summaries` table. If that write fails,
its detail is not deleted. The snapshot keeps sums, counts and extrema for
heart rate, filtered HRV, legacy breathing and the newer breathing estimate.
It also keeps positive-only averages for the app and the lowest positive
heart rate reported with the score, including the score route's one-minute
boundary tolerance. The recent-night floor counts local wake dates, so
multiple recordings on one date do not count as two nights. If 100 records
cannot establish that floor, that side's detail is retained.

The historical stage summary API also retains its existing epochs and totals
for recorded nights within its 48-hour request limit. Its classifier is
unchanged. Partial batches do not replace a full snapshot with a summary of
the remaining detail.

Historical night views use the saved summary, including after switching
between breathing estimators. Larger ranges combine fully enclosed,
non-overlapping saved nights with detail outside those nights. Snapshots
cannot reconstruct a newly requested slice within a pruned night or detail
outside recorded nights. Editing a pruned night's boundaries cannot recover
its original minute readings. Older versions can still read and write their
existing tables, but do not know how to display the new retained summaries.
Rollback cannot recover deleted detail. Switching either setting off stops
its future deletions.

## Space and headroom

Deletion does not shrink the SQLite database file or increase filesystem
free space. It makes pages reusable by new database writes, limiting further
growth. The stop target is `freelist_count * page_size >= 16 MiB`, not a
claim that pruning restored 150 MiB of filesystem free space. If enough
reusable pages already exist, low-disk protection deletes nothing.

At roughly one vitals row per minute per side, a conservative budgeting
assumption of 1 KiB per row including indexes gives about 2.8 MiB per day.
The 16 MiB target budgets roughly five days of vitals growth. This is a
headroom estimate, not a measured Pod growth rate, and does not cover RAW
files or other processes. Keeping recent nights and summaries takes priority
if insufficient eligible detail remains.

The job never runs VACUUM. VACUUM needs temporary storage for another copy
of the database and can be unsafe on an almost-full filesystem. Reusing
pages avoids that extra-space requirement. Other files filling the disk
still need separate attention.

The migration adds only the nightly summary table. Install and update
apply migrations through the existing `prisma migrate deploy` path. Shipped
migration checksums are pinned by the release process, not by this change.

## Rhythms notes

With Suggestions from your changes on, `rhythms-changes.jsonl` in the data
folder keeps hand changes and what the schedule set during each rhythm
night. Lines older than 90 days are removed each time a rhythm night starts.
Two sides come to well under 1 MB at 90 days. The file is not in backups,
neither switch above touches it, and Delete notes removes it.
