import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app.js';
import { getWebEnvironment } from './config/environment.js';
import './styles.css';

getWebEnvironment();

const rootElement = document.querySelector('#root');

if (rootElement === null) {
  throw new Error('CreatorDrop root element is missing.');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
