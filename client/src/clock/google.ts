/**
 * Google Identity Services: the official "Continue with Google" button (pill,
 * outline / filled-black for dark mode). The ID token it returns is checked on the
 * server; Google's own account chooser is the "choose an account" step.
 */

interface GisId {
  initialize: (o: Record<string, unknown>) => void;
  renderButton: (el: HTMLElement, o: Record<string, unknown>) => void;
  disableAutoSelect?: () => void;
}
declare global {
  interface Window {
    google?: { accounts?: { id?: GisId } };
  }
}

let loading: Promise<void> | null = null;

export function loadGis(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error('Google sign-in could not load. Check the connection.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

export interface GoogleButtonOptions {
  clientId: string;
  container: HTMLElement;
  /** Leave out to let Google size the button to its text (no empty sides). */
  width?: number;
  dark: boolean;
  locale: string;
  onCredential: (credential: string) => void;
}

export async function renderGoogleButton(o: GoogleButtonOptions): Promise<void> {
  await loadGis();
  const g = window.google!.accounts!.id!;
  g.initialize({
    client_id: o.clientId,
    callback: (resp: { credential?: string }) => {
      if (resp?.credential) o.onCredential(resp.credential);
    },
    ux_mode: 'popup',
    auto_select: false,
    cancel_on_tap_outside: true,
    itp_support: true,
    use_fedcm_for_button: true,
  });
  o.container.innerHTML = '';
  g.renderButton(o.container, {
    type: 'standard',
    theme: o.dark ? 'filled_black' : 'outline',
    size: 'large',
    shape: 'pill',
    text: 'continue_with',
    logo_alignment: 'left',
    ...(o.width ? { width: Math.max(200, Math.min(400, Math.round(o.width))) } : {}),
    locale: o.locale,
  });
}
