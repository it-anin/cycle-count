import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { installCrashScreen } from './lib/crashScreen';

import App from './App';
import './styles.css';

// ติดตั้งก่อน render — error ที่ทำให้จอขาวมักเกิดก่อน React จะ mount ด้วยซ้ำ
installCrashScreen();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
