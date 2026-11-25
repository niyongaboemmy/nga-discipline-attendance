import { beginSsoState } from './ssoState';

/**
 * Sends the browser through NGA MIS SSO. With an MIS session MIS answers at
 * once with a code for the school that session is in (so a re-sign-in after
 * a school switch lands in the new school); without one it shows its login.
 */
export function startMisSignIn() {
  const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
  const loginUrl = import.meta.env.VITE_MIS_LOGIN_URL;
  const redirectUri = `${window.location.origin}/sso/callback`;
  // `state` is the OAuth CSRF token: the MIS echoes it back to /sso/callback,
  // which checks it against the copy kept in this tab's sessionStorage.
  const state = beginSsoState();
  window.location.href = `${loginUrl}?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(state)}`;
}
