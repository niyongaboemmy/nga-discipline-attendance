import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClockApp } from './ClockApp';
import './clock.css';

createRoot(document.getElementById('clock-root')!).render(
  <StrictMode>
    <ClockApp />
  </StrictMode>
);

// The app's service worker (public/sw.js) also covers /c/: it keeps this page for
// offline launches. Registered quietly; failures never block the page.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
