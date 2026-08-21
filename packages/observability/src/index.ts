export interface Logger {
  error(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
}

export type LogAttributeValue = boolean | null | number | string;
export type LogAttributes = Readonly<Record<string, LogAttributeValue>>;

export interface ConsoleLoggerOptions {
  readonly now?: () => Date;
  readonly service: string;
  readonly write?: (line: string) => void;
}

const sensitiveAttributeName =
  /authorization|cookie|credential|password|secret|token|api[-_]?key/iu;
const reservedAttributeNames = new Set(['level', 'message', 'service', 'timestamp']);

const redactAttributes = (attributes: LogAttributes): LogAttributes =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([name]) => !reservedAttributeNames.has(name))
      .map(([name, value]) => [name, sensitiveAttributeName.test(name) ? '[REDACTED]' : value]),
  );

export const createConsoleLogger = ({
  now = () => new Date(),
  service,
  write = (line: string) => console.log(line),
}: ConsoleLoggerOptions): Logger => {
  const log = (level: 'error' | 'info', message: string, attributes: LogAttributes = {}): void => {
    write(
      JSON.stringify({
        level,
        message,
        service,
        timestamp: now().toISOString(),
        ...redactAttributes(attributes),
      }),
    );
  };

  return {
    error: (message, attributes) => log('error', message, attributes),
    info: (message, attributes) => log('info', message, attributes),
  };
};
