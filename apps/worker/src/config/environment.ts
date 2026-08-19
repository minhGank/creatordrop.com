import { parseWorkerEnvironment, type WorkerEnvironment } from '@creatordrop/config';

export const getWorkerEnvironment = (): WorkerEnvironment => parseWorkerEnvironment(process.env);
