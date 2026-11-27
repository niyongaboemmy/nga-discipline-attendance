import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initNgaInstall, NgaInstallPrompt } from './pwa/ngaInstall'
import { startActivity } from './activity'
import { installNetActivity } from './net/trackRequests'
// The school's header and footer on every PDF and printed page (utils/documentLetterhead).
import './api/letterheadSource'

// Every change sent to the server shows a small "Saving…" pill (net/NetActivity).
installNetActivity()

// Installable app + "install this too" when opened from the installed NGA app.
initNgaInstall()

// Platform usage analytics (relayed to the MIS through /api/activity).
startActivity()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <NgaInstallPrompt appName="Tendo" accent="#1e6fd9" />
  </StrictMode>,
)
