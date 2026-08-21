import {
  parseApiEnvironment,
  parseDatabaseEnvironment,
  type ApiEnvironment,
  type DatabaseEnvironment,
} from '@creatordrop/config';

export const getApiEnvironment = (): ApiEnvironment => parseApiEnvironment(process.env);

export const getDatabaseEnvironment = (): DatabaseEnvironment =>
  parseDatabaseEnvironment(process.env);
