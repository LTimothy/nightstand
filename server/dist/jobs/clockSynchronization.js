import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
// The marker records a timesyncd sync in this boot. Older systems may only expose timedatectl.
export async function readNtpSynchronization() {
    try {
        await access('/run/systemd/timesync/synchronized');
        return true;
    }
    catch {
        // A missing marker does not say whether this system supports timesyncd.
    }
    return new Promise(resolve => {
        execFile('timedatectl', ['show', '-p', 'NTPSynchronized'], { timeout: 2000, encoding: 'utf8' }, (error, stdout) => {
            if (error)
                return resolve(undefined);
            const value = /^NTPSynchronized=(yes|no)$/m.exec(stdout.trim())?.[1];
            resolve(value === 'yes' ? true : value === 'no' ? false : undefined);
        });
    });
}
//# sourceMappingURL=clockSynchronization.js.map