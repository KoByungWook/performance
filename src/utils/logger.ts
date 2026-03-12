import { config } from '../config';

const prefix = `[instance-${config.instanceId}]`;

export const logger = {
  info: (msg: string, ...args: unknown[]) => {
    console.log(`${new Date().toISOString()} ${prefix} INFO  ${msg}`, ...args);
  },
  error: (msg: string | unknown, ...args: unknown[]) => {
    console.error(`${new Date().toISOString()} ${prefix} ERROR ${msg}`, ...args);
  },
  warn: (msg: string, ...args: unknown[]) => {
    console.warn(`${new Date().toISOString()} ${prefix} WARN  ${msg}`, ...args);
  },
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`${new Date().toISOString()} ${prefix} DEBUG ${msg}`, ...args);
    }
  },
};
