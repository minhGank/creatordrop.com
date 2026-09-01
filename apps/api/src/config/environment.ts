import {
  assertCryptographicKeySeparation,
  parseApiEnvironment,
  parseDatabaseEnvironment,
  parseFulfillmentEnvironment,
  parseRngEnvironment,
  type ApiEnvironment,
  type DatabaseEnvironment,
  type FulfillmentEnvironment,
  type RngEnvironment,
} from '@creatordrop/config';

export const getApiEnvironment = (): ApiEnvironment => parseApiEnvironment(process.env);

export const getDatabaseEnvironment = (): DatabaseEnvironment =>
  parseDatabaseEnvironment(process.env);

export const getRngEnvironment = (): RngEnvironment => parseRngEnvironment(process.env);

export const getFulfillmentEnvironment = (): FulfillmentEnvironment =>
  parseFulfillmentEnvironment(process.env);

export const validateCryptographicKeySeparation = (
  rng: RngEnvironment,
  fulfillment: FulfillmentEnvironment,
): void => {
  assertCryptographicKeySeparation({ fulfillment, rng });
};
