export interface Logger {
  error(message: string): void;
  info(message: string): void;
}

export interface ConsoleLoggerOptions {
  readonly now?: () => Date;
  readonly service: string;
  readonly write?: (line: string) => void;
}

export const createConsoleLogger = ({
  now = () => new Date(),
  service,
  write = (line: string) => console.log(line),
}: ConsoleLoggerOptions): Logger => {
  const log = (level: 'error' | 'info', message: string): void => {
    write(JSON.stringify({ level, message, service, timestamp: now().toISOString() }));
  };

  return {
    error: (message) => log('error', message),
    info: (message) => log('info', message),
  };
};
