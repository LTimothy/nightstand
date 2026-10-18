// The eMMC chip's own wear estimate and the kernel's write counter, from
// /sys/block/mmcblk0/device/{life_time,pre_eol_info}, /sys/block/mmcblk0/stat
// and /proc/uptime. 0 and anything outside the defined ranges (1 to 11, pre_eol 1 to 3) mean the chip gives no value.
export type FlashWear = {
  lifeTimeA: number | null;
  lifeTimeB: number | null;
  preEolInfo: number | null;
  writtenBytesPerDay: number | null;
};

const level = (text: string | undefined, max: number) => {
  const value = text ? Number.parseInt(text, 16) : Number.NaN;
  return Number.isInteger(value) && value >= 1 && value <= max ? value : null;
};

export function parseFlashWear(lifeTime: string, preEol: string, stat: string, uptime: string): FlashWear | null {
  const [a, b] = lifeTime.trim().split(/\s+/);
  const sectors = Number(stat.trim().split(/\s+/)[6]);
  const seconds = Number(uptime.trim().split(/\s+/)[0]);
  const wear: FlashWear = {
    lifeTimeA: level(a, 11),
    lifeTimeB: level(b, 11),
    preEolInfo: level(preEol.trim(), 3),
    // Under an hour after boot the average says little.
    writtenBytesPerDay: Number.isFinite(sectors) && seconds >= 3600 ? Math.round(sectors * 512 / seconds * 86400) : null,
  };
  return Object.values(wear).every(value => value === null) ? null : wear;
}
