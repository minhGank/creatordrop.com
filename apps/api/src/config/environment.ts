import { parseApiEnvironment, type ApiEnvironment } from '@creatordrop/config';

export const getApiEnvironment = (): ApiEnvironment => parseApiEnvironment(process.env);
