import {
  parseApiEnvironment,
  parseDatabaseEnvironment,
  parseRngEnvironment,
  type ApiEnvironment,
  type DatabaseEnvironment,
  type RngEnvironment,
} from '@creatordrop/config';

export const getApiEnvironment = (): ApiEnvironment => parseApiEnvironment(process.env);

export const getDatabaseEnvironment = (): DatabaseEnvironment =>
  parseDatabaseEnvironment(process.env);

export const getRngEnvironment = (): RngEnvironment => parseRngEnvironment(process.env);
