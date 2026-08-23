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
const normalizedAttributeName = (name: string): string =>
  name.replaceAll(/[^a-z0-9]/giu, '').toLowerCase();
const rngSensitiveAttributeName = (name: string): boolean => {
  const normalized = normalizedAttributeName(name);
  return (
    normalized.endsWith('serverseed') ||
    normalized.includes('serverseedciphertext') ||
    normalized.includes('serverseedplaintext') ||
    normalized.includes('serverseedraw') ||
    normalized.includes('serverseedbytes') ||
    normalized.includes('serverseedhex') ||
    normalized.includes('revealedserverseed') ||
    normalized.includes('activeserverseed') ||
    normalized.includes('masterkey') ||
    normalized.includes('authenticationtag') ||
    normalized.includes('encryptionauthtag') ||
    normalized.includes('encryptioniv') ||
    normalized === 'ciphertext'
  );
};
const reservedAttributeNames = new Set(['level', 'message', 'service', 'timestamp']);

const redactAttributes = (attributes: LogAttributes): LogAttributes =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([name]) => !reservedAttributeNames.has(name))
      .map(([name, value]) => [
        name,
        sensitiveAttributeName.test(name) || rngSensitiveAttributeName(name) ? '[REDACTED]' : value,
      ]),
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
