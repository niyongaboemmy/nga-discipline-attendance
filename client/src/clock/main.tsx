import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ClockApp } from './ClockApp';
import { PairApp } from './PairApp';
import { TapApp } from './TapApp';
import './clock.css';

// /c/<school>/pair/<code>: a phone lending its GPS to an admin's setup on a computer.
const pair = window.location.pathname.match(/^\/c\/([A-Za-z0-9-]{1,63})\/pair\/([A-Za-z0-9_-]{8,64})\/?$/);
// /c/<school>/tap/<code>: a phone lending its location to a staff member's check-in on a computer.
const tap = window.location.pathname.match(/^\/c\/([A-Za-z0-9-]{1,63})\/tap\/([A-Za-z0-9_-]{8,64})\/?$/);

createRoot(document.getElementById('clock-root')!).render(
  <StrictMode>
    {pair ? <PairApp slug={pair[1].toLowerCase()} code={pair[2]} /> : tap ? <TapApp slug={tap[1].toLowerCase()} code={tap[2]} /> : <ClockApp />}
  </StrictMode>
);

// The app's service worker (public/sw.js) also covers /c/: it keeps this page for
// offline launches. Registered quietly; failures never block the page.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => undefined));
}
