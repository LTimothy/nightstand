import { existsSync, readFileSync } from 'fs';
import logger from './logger.js';


function checkIfDacSockPathConfigured(): string | undefined {
  try {
    // Check if the file exists
    const filePath = '/persistent/free-sleep-data/dac_sock_path.txt';
    if (!existsSync(filePath)) {
      logger.debug(`dac.sock path not configured, defaulting to pod 3 path...`);
      return;
    }

    const data = readFileSync(filePath, 'utf8');

    // Remove all newline characters
    return data.replace(/\r?\n/g, '');
  } catch (error) {
    logger.error(error);
  }
}


// Some firmware has no frank.sh and sets DAC_SOCKET in the unit; an /etc unit overrides the /lib one.
const FRANK_SOURCES = ['/opt/eight/bin/frank.sh', '/etc/systemd/system/frank.service', '/lib/systemd/system/frank.service'];

// The installer copies the firmware's socket path out of these files; read it
// the same way when that copy is missing, rather than assume a Pod 3.
export function sockPathFromFrankScript(text: string): string | undefined {
  return /DAC_SOCKET=([^\s"]*dac\.sock)/.exec(text)?.[1];
}

export function sockPathFromSources(read: (file: string) => string | undefined, files = FRANK_SOURCES): string | undefined {
  for (const file of files) {
    const text = read(file);
    const found = text === undefined ? undefined : sockPathFromFrankScript(text);
    if (found) return found;
  }
  return undefined;
}

function sockPathFromFirmware(): string | undefined {
  return sockPathFromSources((file) => {
    try {
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    } catch (error) {
      logger.error(error);
      return undefined;
    }
  });
}

// An empty copy counts as missing, so the firmware's path still wins over the Pod 3 default.
export function pickSockPath(
  configured: string | undefined,
  remoteDevMode: boolean,
  fromFirmware: () => string | undefined,
): string | undefined {
  return configured || (remoteDevMode ? undefined : fromFirmware());
}

type FirmwareVersion = 'pod3FirmwareReset' | 'pod4FirmwareReset' | 'remoteDevMode';

interface FirmwareConfig {
  dacLocation: string;
}

const FIRMWARE_MAP: Record<FirmwareVersion, FirmwareConfig> = {
  remoteDevMode: {
    dacLocation: `${process.env.DATA_FOLDER}/dac.sock`,
  },
  pod3FirmwareReset: {
    dacLocation: '/deviceinfo/dac.sock',
  },
  pod4FirmwareReset: {
    dacLocation: '/persistent/deviceinfo/dac.sock',
  },
};


class Config {
  // eslint-disable-next-line no-use-before-define
  private static instance: Config;
  public dbFolder: string;
  public lowDbFolder: string;
  public remoteDevMode: boolean;
  public dacSockPath: string;

  private constructor() {
    if (!process.env.DATA_FOLDER || !process.env.ENV) {
      throw new Error('Missing DATA_FOLDER || ENV in env');
    }
    this.remoteDevMode = process.env.ENV === 'local';
    this.dacSockPath = this.detectSockPath();
    this.dbFolder = process.env.DATA_FOLDER;
    this.lowDbFolder = `${this.dbFolder}lowdb/`;
  }


  private detectSockPath(): string {
    const dacSockPath = pickSockPath(checkIfDacSockPathConfigured(), this.remoteDevMode, sockPathFromFirmware);

    if (dacSockPath) {
      logger.debug(`'Custom dac.sock path configured, using ${dacSockPath}`);
      return dacSockPath;
    } else if (!this.remoteDevMode){
      logger.warn(`No dac.sock path in ${process.env.DATA_FOLDER}dac_sock_path.txt or the frank files, defaulting to the Pod 3 path`);
      return FIRMWARE_MAP.pod3FirmwareReset.dacLocation;

    } else if (this.remoteDevMode) {
      return FIRMWARE_MAP.remoteDevMode.dacLocation;
    } else {
      throw new Error('Error - Did not detect device firmware');
    }
  }

  public static getInstance(): Config {
    if (!Config.instance) {
      Config.instance = new Config();
    }
    return Config.instance;
  }
}

export default Config.getInstance();
