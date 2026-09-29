import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initNgaInstall, NgaInstallPrompt } from './pwa/ngaInstall'

// Installable app + "install this too" when opened from the installed NGA app.
initNgaInstall()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <NgaInstallPrompt appName="Tendo" accent="#1e6fd9" />
  </StrictMode>,
)
