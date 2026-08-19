import express, { type Express, type Request, type Response } from 'express';

import type { ServiceStatusResponse } from '@creatordrop/contracts';

const sendStatus =
  (status: ServiceStatusResponse['status']) =>
  (_request: Request, response: Response<ServiceStatusResponse>): void => {
    response.status(200).json({ service: 'api', status });
  };

export const createApp = (): Express => {
  const app = express();

  app.disable('x-powered-by');
  app.get('/health', sendStatus('ok'));
  app.get('/ready', sendStatus('ready'));

  return app;
};
