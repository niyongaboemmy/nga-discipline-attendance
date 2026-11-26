import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clockApi, ClockApiError, OfflineError, type Bootstrap, type DayState, type Me, type PunchResult, type RegisterPreview, type Registered } from './api';
import { askPersistentStorage, deviceInfo, ensureKeys, forgetDevice, installUuid, isTabletDevice, loadDevice, ngaDeviceId, saveToken, signMessage, supportsDeviceKeys } from './device';
import { formatDistance, GeoError, permissionState, sampleLocation, weakButPlausible, zoneHint, type Fix, type ZoneHint } from './geo';
import { renderGoogleButton } from './google';
import { PhoneTap } from './PhoneTap';
import { QuickIcons, QuickMissed, QuickSheets, type QuickWhich } from './Quick';
import { reminderSupport, unsubscribeReminders } from './reminders';
import { detectLang, makeT, type Lang, type T } from './i18n';
import {
  IconAddHome, IconCheck, IconChevron, IconClock, IconDeviceOff, IconHelp, IconKeyboard, IconMail, IconPhone, IconPhoneCheck, IconPin, IconPinOff, IconQr, IconRetry, IconShield, IconUser, IconWarn, IconWifi,
} from './icons';

/**
 * The staff clock page (/c/<school>): register this device once with Google, then
 * one button a day -- Check in, Check out, Done for today. Phone and tablet layouts
 * come from clock.css (768 px and up = tablet). STAFF_ATTENDANCE_CLOCK_PLAN.md §8.
 */

type View = 'loading' | 'fatal' | 'welcome' | 'confirm' | 'location' | 'denied' | 'pending' | 'revoked' | 'daily' | 'success';
type GeoMode = 'idle' | 'locating' | 'ok' | 'outside' | 'vague' | 'failed';
type Theme = 'auto' | 'light' | 'dark';
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

const LOCALES: Record<Lang, string> = { en: 'en-GB', rw: 'rw-RW', fr: 'fr-FR' };
const SLUG_KEY = 'tendo.clock.lastSlug';

function slugFromPath(): string | null {
  const m = window.location.pathname.match(/^\/c\/([A-Za-z0-9-]{1,63})\/?$/);
  if (m) {
    localStorage.setItem(SLUG_KEY, m[1].toLowerCase());
    return m[1].toLowerCase();
  }
  const last = localStorage.getItem(SLUG_KEY);
  if (last) {
    window.history.replaceState(null, '', `/c/${last}`);
    return last;
  }
  return null;
}

function applyTheme(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'auto' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  return !!dark;
}

const fmtDuration = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h} h ${m} min` : `${m} min`;
};

function safeFormat(locale: string, opts: Intl.DateTimeFormatOptions, d: Date): string {
  try {
    return new Intl.DateTimeFormat(locale, opts).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(d);
  }
}

export function ClockApp() {
  const [slug] = useState(slugFromPath);
  const [lang, setLang] = useState<Lang>(detectLang);
  const t = useMemo(() => makeT(lang), [lang]);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('tendo.clock.theme') as Theme) || 'auto');
  const [systemDark, setSystemDark] = useState(() => !!window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  const dark = theme === 'dark' || (theme === 'auto' && systemDark);
  const tablet = useMemo(() => isTabletDevice(), []);
  const deviceWord = tablet ? t('tablet') : t('phone');

  const [view, setView] = useState<View>('loading');
  const [fatal, setFatal] = useState<{ title: string; lead: string; retry?: boolean } | null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [offset, setOffset] = useState(0);
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [preview, setPreview] = useState<(RegisterPreview & { credential: string }) | null>(null);
  const [registering, setRegistering] = useState(false);
  const [welcomeError, setWelcomeError] = useState<string | null>(null);
  /** the Google account is not on the school's list: offer the profile card where staff link it */
  const [noAccount, setNoAccount] = useState<string | null>(null);
  const [helpTopic, setHelpTopic] = useState<HelpTopic | null>(null);
  const [geoMode, setGeoMode] = useState<GeoMode>('idle');
  const [fix, setFix] = useState<{ best: Fix; samples: Fix[]; at: number } | null>(null);
  /** while locating: the best precision so far, in metres (GPS settling on mobile data) */
  const [seeking, setSeeking] = useState<number | null>(null);
  /** the reading is vague but the school accepts it for review */
  const [weak, setWeak] = useState(false);
  const [schoolCode, setSchoolCode] = useState('');
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  /** which popup of the daily screen is open: my calendar, reminders, a forgotten check-out */
  const [quickOpen, setQuickOpen] = useState<QuickWhich | null>(null);
  const [hint, setHint] = useState<ZoneHint | null>(null);
  const [serverOutside, setServerOutside] = useState<number | null>(null);
  const [busy, setBusy] = useState<'in' | 'out' | null>(null);
  const [offline, setOffline] = useState(false);
  const [confirmOut, setConfirmOut] = useState(false);
  const [help, setHelp] = useState(false);
  const [toast, setToast] = useState<{ msg: string; error?: boolean } | null>(null);
  const [success, setSuccess] = useState<PunchResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [installEvt, setInstallEvt] = useState<InstallPromptEvent | null>(null);
  const [tipHidden, setTipHidden] = useState(() => localStorage.getItem('tendo.clock.tipHidden') === '1');
  const [justRegistered, setJustRegistered] = useState(false);
  /** the phone QR panel: null = automatic (open on a computer whose location fails), true/false = the person chose */
  const [phoneChoice, setPhoneChoice] = useState<boolean | null>(null);
  const googleSlot = useRef<HTMLDivElement>(null);
  /** The latest bootstrap for callbacks created before it arrived (first load). */
  const bootRef = useRef<Bootstrap | null>(null);
  /** this device registered as a computer: its location never improves, so no long GPS wait */
  const computerRef = useRef(false);
  const toastTimer = useRef<number | undefined>(undefined);

  const flash = useCallback((msg: string, error = false) => {
    setToast({ msg, error });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2600);
  }, []);

  // Theme + language persistence.
  useEffect(() => {
    localStorage.setItem('tendo.clock.theme', theme);
    applyTheme(theme);
  }, [theme, systemDark]);
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const on = () => setSystemDark(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  useEffect(() => {
    localStorage.setItem('tendo.clock.lang', lang);
    document.documentElement.lang = lang;
  }, [lang]);

  // The school clock: server time + offset, ticking.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    const on = (e: Event) => {
      e.preventDefault();
      setInstallEvt(e as InstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);

  const schoolNow = new Date(now + offset);
  const tz = boot?.timezone || 'Africa/Kigali';
  const locale = LOCALES[lang];
  const clockText = safeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }, schoolNow);
  const dateText = safeFormat(locale, { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long' }, schoolNow);
  const hour = Number(safeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }, schoolNow));
  const place = tz.split('/').pop()!.replace(/_/g, ' ');

  const adoptServerTime = (iso: string) => {
    const s = Date.parse(iso);
    if (Number.isFinite(s)) setOffset(s - Date.now());
  };

  // ---------------------------------------------------------------- location
  const locate = useCallback(
    async (quick = false): Promise<{ best: Fix; samples: Fix[] } | null> => {
      const boot = bootRef.current;
      if (!boot) return null;
      setGeoMode('locating');
      setServerOutside(null);
      setSeeking(null);
      setWeak(false);
      try {
        // A phone or tablet off the school Wi-Fi starts from a cell-tower guess: GPS needs
        // up to 20 s to settle, so wait for it instead of giving up on the first vague reading.
        // A computer never improves, so it keeps the short wait (and the "use my phone" way).
        const handheld = !computerRef.current && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
        const r = await sampleLocation({
          maxMs: handheld ? (quick ? 15000 : 20000) : quick ? 5000 : 8000,
          goodEnough: 20,
          patientUntil: handheld && boot.rules.requireZone ? boot.rules.maxAccuracy : undefined,
          onProgress: (b) => setSeeking(Math.round(b.accuracy)),
        });
        setFix({ ...r, at: Date.now() });
        const h = zoneHint(r.best, boot.zones, boot.rules);
        setHint(h);
        const weakOk = weakButPlausible(r.best, h, boot.rules);
        setWeak(boot.rules.requireZone && weakOk);
        if (!boot.rules.requireZone || !h) setGeoMode('ok');
        else setGeoMode(!h.preciseEnough ? (weakOk ? 'ok' : 'vague') : h.inside ? 'ok' : 'outside');
        return r;
      } catch (err) {
        if (err instanceof GeoError && err.kind === 'denied') {
          setGeoMode('failed');
          setView('denied');
        } else {
          setGeoMode('vague');
          setHint(null);
        }
        return null;
      }
    },
    []
  );

  // ---------------------------------------------------------------- loading
  const enterDaily = useCallback(
    async (m: Me) => {
      setMe(m);
      computerRef.current = m.device.formFactor === 'desktop';
      adoptServerTime(m.serverNow);
      if (m.device.status === 'pending') return setView('pending');
      if (!m.open) {
        setFatal({ title: t('clockOff'), lead: t('clockOffLead') });
        return setView('fatal');
      }
      const perm = await permissionState();
      if (perm === 'denied') return setView('denied');
      if (perm !== 'granted' && !localStorage.getItem('tendo.clock.locPrimed')) return setView('location');
      setView('daily');
      if (m.next === 'check_in' || m.next === 'check_out') void locate();
    },
    [locate, t]
  );

  const handleDeviceError = useCallback(
    async (err: unknown): Promise<boolean> => {
      if (err instanceof ClockApiError && (err.code === 'DEVICE_REVOKED' || err.code === 'DEVICE_UNKNOWN')) {
        await forgetDevice(slug!);
        setToken(null);
        setMe(null);
        setView(err.code === 'DEVICE_REVOKED' ? 'revoked' : 'welcome');
        return true;
      }
      if (err instanceof ClockApiError && err.code === 'DEVICE_PENDING') {
        setView('pending');
        return true;
      }
      return false;
    },
    [slug]
  );

  const start = useCallback(async () => {
    if (!slug) {
      setFatal({ title: t('schoolUnknown'), lead: t('schoolUnknownLead') });
      return setView('fatal');
    }
    if (!supportsDeviceKeys()) {
      setFatal({ title: t('unsupported'), lead: t('unsupportedLead') });
      return setView('fatal');
    }
    setView('loading');
    try {
      const b = await clockApi.bootstrap(slug);
      bootRef.current = b;
      setBoot(b);
      adoptServerTime(b.serverNow);
      document.title = `${t('staffAttendance')} · ${b.school.name}`;
      let stored = await loadDevice(slug);
      // Opened from the Home Screen icon with a sign-in code (an iPhone gives the installed app
      // empty storage): take over the sign-in of the page it was installed from, once.
      const handoffCode = new URLSearchParams(window.location.search).get('h');
      if (handoffCode) window.history.replaceState(null, '', `/c/${slug}`);
      if (!stored?.token && handoffCode && b.open) {
        try {
          const keys = await ensureKeys(slug);
          const res = await clockApi.claimHandoff(slug, { code: handoffCode, publicKeyJwk: keys.publicJwk, installUuid: await installUuid(), ngaDid: ngaDeviceId(), device: await deviceInfo() });
          await saveToken(slug, res.deviceToken);
          void askPersistentStorage();
          stored = await loadDevice(slug);
        } catch {
          /* expired or used: the welcome screen asks for Google sign-in */
        }
      }
      if (stored?.token) {
        setToken(stored.token);
        try {
          const m = await clockApi.me(slug, stored.token);
          return enterDaily(m);
        } catch (err) {
          if (await handleDeviceError(err)) return;
          throw err;
        }
      }
      if (!b.open) {
        setFatal({ title: t('clockOff'), lead: t('clockOffLead') });
        return setView('fatal');
      }
      setView('welcome');
    } catch (err) {
      if (err instanceof OfflineError) setFatal({ title: t('noConnection'), lead: t('offlineHelp', { device: deviceWord }), retry: true });
      else if (err instanceof ClockApiError && err.code === 'SCHOOL_UNKNOWN') setFatal({ title: t('schoolUnknown'), lead: t('schoolUnknownLead') });
      else if (err instanceof ClockApiError && err.code === 'CLOCK_OFF') setFatal({ title: t('clockOff'), lead: t('clockOffLead') });
      else setFatal({ title: t('somethingWrong'), lead: err instanceof Error ? err.message : '', retry: true });
      setView('fatal');
    }
  }, [slug, t, enterDaily, handleDeviceError, deviceWord]);

  useEffect(() => {
    // After mount (not inside the effect body): start() updates state.
    void Promise.resolve().then(start);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While signed in in a browser tab, keep the install manifest carrying a fresh sign-in code, so
  // "Add to Home Screen" gives an app that is already signed in (iPhones do not share storage with it).
  useEffect(() => {
    if (view !== 'daily' || !token || !slug) return;
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;
    let live = true;
    const link = document.getElementById('ck-manifest');
    const refresh = async () => {
      try {
        const { code } = await clockApi.handoff(slug, token);
        if (live) link?.setAttribute('href', `/api/clock/${slug}/manifest?h=${code}`);
      } catch {
        /* the plain manifest still opens this school */
      }
    };
    void refresh();
    const id = window.setInterval(() => void refresh(), 8 * 60_000);
    return () => {
      live = false;
      window.clearInterval(id);
      link?.setAttribute('href', `/api/clock/${slug}/manifest`);
    };
  }, [view, token, slug]);

  // Refresh the state when the page comes back (and every minute on screen).
  useEffect(() => {
    if (view !== 'daily' && view !== 'pending') return;
    const refresh = async () => {
      if (!token || !slug) return;
      try {
        const m = await clockApi.me(slug, token);
        setOffline(false);
        setMe(m);
        adoptServerTime(m.serverNow);
        if (view === 'pending' && m.device.status === 'active') void enterDaily(m);
      } catch (err) {
        if (err instanceof OfflineError) setOffline(true);
        else void handleDeviceError(err);
      }
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void refresh();
        if (view === 'daily' && fix && Date.now() - fix.at > 60_000) void locate(true);
      }
    };
    const id = window.setInterval(refresh, 60_000);
    document.addEventListener('visibilitychange', onVisible);
    const online = () => void refresh();
    window.addEventListener('online', online);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', online);
    };
  }, [view, token, slug, fix, locate, enterDaily, handleDeviceError]);

  // ---------------------------------------------------------------- Google
  const onCredential = useCallback(
    async (credential: string) => {
      if (!slug) return;
      setWelcomeError(null);
      setNoAccount(null);
      setRegistering(true);
      try {
        const keys = await ensureKeys(slug);
        const info = await deviceInfo();
        const res = await clockApi.register(slug, {
          credential, publicKeyJwk: keys.publicJwk, installUuid: await installUuid(), ngaDid: ngaDeviceId(), device: info, confirm: false,
        });
        setPreview({ ...(res as RegisterPreview), credential });
        setView('confirm');
      } catch (err) {
        setWelcomeError(registerErrorText(err, t, deviceWord));
        setNoAccount(err instanceof ClockApiError && err.code === 'NO_ACCOUNT' ? String(err.data.email ?? '') : null);
      } finally {
        setRegistering(false);
      }
    },
    [slug, t, deviceWord]
  );

  useEffect(() => {
    if (view !== 'welcome' || !boot?.googleClientId || !googleSlot.current) return;
    const el = googleSlot.current;
    renderGoogleButton({ clientId: boot.googleClientId, container: el, dark, locale: lang === 'rw' ? 'rw' : lang, onCredential }).catch(() =>
      setWelcomeError(t('somethingWrong'))
    );
  }, [view, boot, dark, lang, onCredential, t]);

  const confirmDevice = async () => {
    if (!slug || !preview) return;
    setRegistering(true);
    try {
      const keys = await ensureKeys(slug);
      const info = await deviceInfo();
      const res = (await clockApi.register(slug, {
        credential: preview.credential, publicKeyJwk: keys.publicJwk, installUuid: await installUuid(), ngaDid: ngaDeviceId(), device: info, confirm: true,
      })) as Registered;
      await saveToken(slug, res.deviceToken);
      void askPersistentStorage();
      setToken(res.deviceToken);
      setJustRegistered(true);
      const m = await clockApi.me(slug, res.deviceToken);
      await enterDaily(m);
    } catch (err) {
      setPreview(null);
      setWelcomeError(registerErrorText(err, t, deviceWord));
      setView('welcome');
    } finally {
      setRegistering(false);
    }
  };

  const allowLocation = async () => {
    localStorage.setItem('tendo.clock.locPrimed', '1');
    setView('daily');
    if (me && (me.next === 'check_in' || me.next === 'check_out')) {
      const r = await locate();
      if (!r && (await permissionState()) === 'denied') setView('denied');
    }
  };

  // ---------------------------------------------------------------- the tap
  const doPunch = async (kind: 'in' | 'out') => {
    if (!slug || !token || busy) return;
    setBusy(kind);
    setConfirmOut(false);
    try {
      let position = fix && Date.now() - fix.at < 30_000 ? fix : null;
      if (!position) {
        const r = await locate(true);
        if (!r) return;
        position = { ...r, at: Date.now() };
      }
      const { nonce } = await clockApi.challenge(slug, token);
      const stored = await loadDevice(slug);
      if (!stored) throw new ClockApiError(401, 'DEVICE_UNKNOWN', 'missing key');
      const p = { lat: position.best.lat, lng: position.best.lng, accuracy: position.best.accuracy };
      const signature = await signMessage(stored, `tendo-clock-v1|${nonce}|${p.lat}|${p.lng}|${p.accuracy}`);
      const result = await clockApi.punch(slug, token, {
        nonce, signature, position: { ...p, ts: position.best.ts }, samples: position.samples, clientTime: new Date().toISOString(),
      });
      setOffline(false);
      setMe((m) => (m ? { ...m, ...result.state } : m));
      adoptServerTime(result.state.serverNow);
      if ('vibrate' in navigator) navigator.vibrate?.(30);
      if (result.action === 'check_in') {
        setSuccess(result);
        setView('success');
        flash(t('savedIn', { time: result.at }));
      } else {
        flash(t('savedOut', { time: result.at }));
      }
    } catch (err) {
      if (err instanceof OfflineError) {
        setOffline(true);
      } else if (await handleDeviceError(err)) {
        /* handled */
      } else if (err instanceof ClockApiError) {
        if (err.code === 'OUTSIDE_ZONE') {
          setGeoMode('outside');
          setServerOutside(typeof err.data.distance === 'number' ? err.data.distance : null);
        } else if (err.code === 'LOW_ACCURACY') {
          setGeoMode('vague');
          setHint((h) => (h ? { ...h, preciseEnough: false } : h));
        } else if (err.code === 'CLOCK_OFF') {
          setFatal({ title: t('clockOff'), lead: t('clockOffLead') });
          setView('fatal');
        } else {
          flash(err.message, true);
          if (['TOO_SOON', 'ALREADY_DONE', 'ALREADY_IN', 'NOT_OPEN', 'NOT_SCHOOL_DAY'].includes(err.code)) {
            const m = await clockApi.me(slug, token).catch(() => null);
            if (m) setMe(m);
          }
        }
      } else {
        flash(t('somethingWrong'), true);
      }
    } finally {
      setBusy(null);
    }
  };

  const onPhoneDone = useCallback(
    async (result: Omit<PunchResult, 'state'>, state: DayState | null) => {
      if (!slug || !token) return;
      const day = state ?? (await clockApi.me(slug, token).catch(() => null));
      if (day) {
        setMe((m) => (m ? { ...m, ...day } : m));
        adoptServerTime(day.serverNow);
      }
      setPhoneChoice(null);
      setGeoMode('ok');
      if (result.action === 'check_in' && day) {
        setSuccess({ ...result, state: day });
        setView('success');
        flash(t('savedIn', { time: result.at }));
      } else {
        flash(result.action === 'check_in' ? t('savedIn', { time: result.at }) : t('savedOut', { time: result.at }));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [slug, token, t]
  );

  /** Sign this device out: the server forgets it, so does the browser, and the page asks for Google again. */
  const signOutHere = async () => {
    if (!slug || !token) return;
    setSigningOut(true);
    try {
      await clockApi.signOut(slug, token).catch((err) => {
        // Already removed on the server: still forget it here.
        if (!(err instanceof ClockApiError) || err.status !== 401) throw err;
      });
      await unsubscribeReminders();
      await forgetDevice(slug);
      setToken(null);
      setMe(null);
      setHelp(false);
      setConfirmSignOut(false);
      setQuickOpen(null);
      flash(t('signedOut'));
      await start();
    } catch (err) {
      flash(err instanceof OfflineError ? t('noInternet') : t('somethingWrong'), true);
    } finally {
      setSigningOut(false);
    }
  };

  const installApp = async () => {
    if (installEvt) {
      installEvt.prompt();
      const r = await installEvt.userChoice.catch(() => null);
      if (r?.outcome === 'accepted') flash(t('installed'));
      setInstallEvt(null);
    } else {
      flash(t('addHomeIos'));
    }
    setTipHidden(true);
    localStorage.setItem('tendo.clock.tipHidden', '1');
  };

  // ---------------------------------------------------------------- render
  // "Use my phone": a computer has no GPS; a phone whose reading fails can lend another phone's.
  const canTap = !!me && (me.next === 'check_in' || (me.next === 'check_out' && !me.checkoutOpensAt));
  const computer = me?.device.formFactor === 'desktop';
  const pushCfg = boot?.pushKey && !computer ? { key: boot.pushKey, minutes: boot.rules.remindMinutes ?? 15 } : null;
  const struggling = geoMode === 'vague' || geoMode === 'failed' || geoMode === 'outside';
  // "Use my phone" is for computers only (they have no GPS). A phone never shows it.
  const offerPhone = canTap && !busy && !offline && computer;
  const phoneOpen = offerPhone && (phoneChoice ?? (computer && struggling));
  const shared = { t, deviceWord, tablet };
  const school = boot?.school.name ?? '';
  const initials = schoolInitials(school);

  return (
    <div className="ck-app">
      {view === 'loading' && <LoadingScreen t={t} />}

      {view === 'fatal' && fatal && (
        <MessageScreen tone="amber" icon={<IconWarn size={42} />} title={fatal.title} lead={fatal.lead}
          action={fatal.retry ? <button className="ck-btn ck-btn-primary ck-btn-block" onClick={() => void start()}>{t('tryAgain')}</button>
            : !slug ? (
              // Opened without a school (an old Home Screen icon): let the person type their school's code.
              <form className="ck-code" onSubmit={(e) => { e.preventDefault(); const c = schoolCode.trim().toLowerCase().replace(/^.*\/c\//, '').replace(/[^a-z0-9-]/g, ''); if (c) window.location.assign(`/c/${c}`); }}>
                <label className="ck-code-label" htmlFor="ck-code">{t('schoolCode')}</label>
                <div className="ck-code-row">
                  <input id="ck-code" className="ck-time" value={schoolCode} onChange={(e) => setSchoolCode(e.target.value)} placeholder={t('schoolCodeHint')} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
                  <button className="ck-x-btn" type="submit" disabled={!schoolCode.trim()}>{t('openSchool')}</button>
                </div>
              </form>
            ) : undefined} />
      )}

      {view === 'welcome' && boot && (
        <main className="ck-screen ck-welcome">
          <div className="ck-welcome-wrap">
            <div className="ck-welcome-hero">
              <div className="ck-welcome-brand">
                <SchoolMark large initials={initials} logoUrl={boot.school.logoUrl} />
                <span>{school}</span>
              </div>
              <h1 className="ck-h1">{t('staffAttendance')}</h1>
              <p className="ck-lead">{t('welcomeLead', { device: deviceWord })}</p>
              <div className="ck-steps">
                <div className="ck-step"><span className="ck-num">1</span>{t('step1')}</div>
                <div className="ck-step"><span className="ck-num">2</span>{t('step2', { device: deviceWord })}</div>
                <div className="ck-step"><span className="ck-num">3</span>{t('step3')}</div>
              </div>
            </div>
            <div className="ck-start">
              <div className="ck-start-head"><h2>{t('getStarted')}</h2><p>{t('getStartedLead')}</p></div>
              {noAccount !== null ? (
                <NoAccountCard t={t} email={noAccount} profileUrl={boot.profileUrl} />
              ) : welcomeError && <div className="ck-alert ck-alert-red" role="alert"><IconWarn size={20} /><span className="ck-wrap">{welcomeError}</span></div>}
              {boot.googleClientId ? (
                <div className="ck-google-slot" aria-busy={registering}>
                  {registering ? <button className="ck-btn ck-btn-secondary ck-btn-block" disabled><span className="ck-spinner" /> {t('loading')}</button> : <div ref={googleSlot} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />}
                </div>
              ) : (
                <div className="ck-alert ck-alert-amber"><IconWarn size={20} /><span>{t('googleNotSet')}</span></div>
              )}
              <button className="ck-link-btn" onClick={() => { setHelpTopic(noAccount !== null ? 'gmail' : null); setHelp(true); }}><IconHelp size={18} />{t('needHelp')}</button>
              <p className="ck-note">{t('staffOnly')}</p>
              <LangPills lang={lang} setLang={setLang} />
            </div>
          </div>
        </main>
      )}

      {view === 'confirm' && preview && (
        <main className="ck-screen ck-cardscreen">
          <div className="ck-card">
            <div className="ck-card-head">
              <div className="ck-badge"><IconPhoneCheck size={44} tablet={tablet} /></div>
              <h1>{t('isThisYours', { device: deviceWord })}</h1>
              <p>{t('confirmLead')}</p>
            </div>
            <div className="ck-person">
              <div className="ck-person-row">
                <span className="ck-avatar">{preview.person.initials}</span>
                <div className="ck-person-name"><b>{preview.person.name}</b><span>{[preview.person.role, school].filter(Boolean).join(' · ')}</span></div>
              </div>
              <div className="ck-divider" />
              <div className="ck-facts">
                <DeviceFact t={t} deviceWord={deviceWord} />
                <div className="ck-fact"><span>{t('googleAccount')}</span><b>{preview.email}</b></div>
              </div>
            </div>
            {tablet ? (
              <div className="ck-alert ck-alert-amber" style={{ marginTop: 16 }}><IconWarn size={22} /><span>{t('familyTablet')}</span></div>
            ) : (
              <div className="ck-alert" style={{ marginTop: 16 }}><IconShield size={22} /><span>{t('onlyYou', { device: deviceWord })}</span></div>
            )}
            {preview.deviceStatus === 'pending' && <div className="ck-alert ck-alert-amber" style={{ marginTop: 12 }}><IconClock size={22} /><span>{t('willWait')}</span></div>}
            <div className="ck-grow" />
            <div className="ck-card-actions">
              <button className="ck-btn ck-btn-primary" onClick={() => void confirmDevice()} disabled={registering}>
                {registering && <span className="ck-spinner" />}{t('yesMine', { device: deviceWord })}
              </button>
              <button className={`ck-btn ${tablet ? 'ck-btn-secondary' : 'ck-btn-text'}`} disabled={registering}
                onClick={() => { setPreview(null); window.google?.accounts?.id?.disableAutoSelect?.(); setView('welcome'); }}>
                {tablet ? t('useAnother') : t('notMe')}
              </button>
            </div>
          </div>
        </main>
      )}

      {view === 'location' && (
        <main className="ck-screen ck-cardscreen">
          <div className="ck-card">
            <div className="ck-card-head">
              <div className="ck-target"><span><IconPin size={30} /></span></div>
              <h1>{t('allowLocation')}</h1>
              <p>{t('locationLead')}</p>
            </div>
            {tablet ? (
              <div className="ck-alert" style={{ marginTop: 20 }}><IconWifi size={22} /><span>{t('wifiTip')}</span></div>
            ) : (
              <div className="ck-bullets">
                {(['locOnlyTap', 'locNever', 'locSchool'] as const).map((k) => (
                  <div className="ck-bullet" key={k}><span className="ck-tick"><IconCheck size={16} sw={2.5} /></span>{t(k)}</div>
                ))}
              </div>
            )}
            <div className="ck-grow" />
            <div className="ck-card-actions">
              <button className="ck-btn ck-btn-primary ck-btn-block" onClick={() => void allowLocation()}>{t('allowLocation')}</button>
            </div>
          </div>
        </main>
      )}

      {view === 'denied' && (
        <DeniedScreen {...shared} onRetry={async () => {
          setView('daily');
          const r = await locate();
          if (!r && (await permissionState()) === 'denied') { setView('denied'); flash(t('locationOff'), true); }
        }} />
      )}

      {view === 'pending' && (
        <MessageScreen tone="blue" icon={<IconClock size={42} />} title={t('waiting')} lead={t('waitingLead')}
          extra={me ? (
            <div className="ck-keyvals">
              <div><span>{t('newDevice')}</span><b>{me.device.label}</b></div>
              <div><span>{t('asked')}</span><b>{safeFormat(locale, { timeZone: tz, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }, new Date(me.device.registeredAt))}</b></div>
            </div>
          ) : undefined}
          action={<button className="ck-btn ck-btn-secondary ck-btn-block" onClick={() => void start()}>{t('checkAgain')}</button>} />
      )}

      {view === 'revoked' && (
        <MessageScreen tone="red" icon={<IconDeviceOff size={42} tablet={tablet} />} title={t('removed', { device: deviceWord })} lead={t('removedLead', { device: deviceWord })}
          action={<button className="ck-btn ck-btn-primary ck-btn-block" onClick={() => setView('welcome')}>{t('registerAgain', { device: deviceWord })}</button>} />
      )}

      {view === 'success' && success && (
        <main className="ck-screen ck-success">
          <div className="ck-success-badge ck-rise"><span><IconCheck size={tablet ? 58 : 48} sw={2.4} /></span></div>
          <h1><span className="ck-only-phone">{t('checkedIn')}</span><span className="ck-only-tablet">{t('checkedInAtTitle', { time: success.at })}</span></h1>
          <div className="ck-success-time ck-only-phone">{success.at}</div>
          <StatusChip t={t} status={success.status} />
          <p>{t('haveGoodDay', { name: me?.person.firstName ?? '' })}</p>
          <button className="ck-btn ck-btn-secondary" onClick={() => { setSuccess(null); setView('daily'); }}>{t('ok')}</button>
        </main>
      )}

      {view === 'daily' && me && boot && (
        <Daily
          phoneOffer={offerPhone && !phoneOpen}
          onPhone={() => setPhoneChoice(true)}
          onPhoneHide={() => setPhoneChoice(false)}
          phonePanel={phoneOpen && slug && token ? (
            <PhoneTap slug={slug} token={token} t={t} next={me.next === 'check_out' ? 'check_out' : 'check_in'} onDone={(r, st) => void onPhoneDone(r, st)} onDeviceError={handleDeviceError} />
          ) : null}
          {...shared}
          me={me}
          school={school}
          initials={initials}
          logoUrl={boot?.school.logoUrl ?? null}
          greeting={t(hour < 12 ? 'goodMorning' : hour < 17 ? 'goodAfternoon' : 'goodEvening', { name: me.person.firstName })}
          clockText={clockText}
          dateText={dateText}
          place={place}
          quickIcons={slug && token && me.device.status === 'active' ? <QuickIcons t={t} me={me} canRemind={!!pushCfg && reminderSupport() !== 'unsupported'} onOpen={setQuickOpen} /> : null}
          quickAlert={slug && token && me.device.status === 'active' ? <QuickMissed t={t} me={me} onOpen={setQuickOpen} /> : null}
          quickSheets={slug && token && me.device.status === 'active' ? (
            <QuickSheets t={t} lang={lang} locale={locale} slug={slug} token={token} me={me} setMe={setMe} flash={flash} push={pushCfg} open={quickOpen} onClose={() => setQuickOpen(null)} />
          ) : null}
          onCalendar={() => setQuickOpen('calendar')}
          geoMode={geoMode}
          seeking={seeking}
          weak={weak}
          maxAccuracy={boot?.rules.maxAccuracy ?? 100}
          hint={hint}
          fix={fix?.best ?? null}
          serverOutside={serverOutside}
          offline={offline}
          busy={busy}
          locale={locale}
          tz={tz}
          showTip={justRegistered && !tipHidden && !window.matchMedia('(display-mode: standalone)').matches && me.today != null}
          onInstall={() => void installApp()}
          onHelp={() => setHelp(true)}
          onTap={() => {
            if (busy) return;
            if (me.next === 'check_in') {
              if (offline || geoMode === 'outside' || geoMode === 'vague' || geoMode === 'failed') void locate(true).then(() => setOffline(false));
              else void doPunch('in');
            } else if (me.next === 'check_out' && !me.checkoutOpensAt) {
              if (offline || geoMode === 'outside' || geoMode === 'vague') void locate(true).then(() => setOffline(false));
              else setConfirmOut(true);
            }
          }}
        />
      )}

      {confirmOut && me?.today && (
        <div className="ck-overlay" onClick={(e) => e.target === e.currentTarget && setConfirmOut(false)}>
          <div className="ck-sheet" role="dialog" aria-modal="true" aria-label={t('checkOutNow')}>
            <div className="ck-grabber" />
            <h2>{t('checkOutNow')}</h2>
            <p className="ck-sheet-lead">{t('checkOutLead', { time: clockText })}</p>
            <div className="ck-stats">
              <div className="ck-stat"><span>{t('checkedInLabel')}</span><b>{me.today.checkIn}</b></div>
              <div className="ck-stat"><span>{t('atSchoolLabel')}</span><b>{fmtDuration(me.today.minutesAtSchool)}</b></div>
            </div>
            <div className="ck-sheet-actions">
              <button className="ck-btn ck-btn-primary" onClick={() => void doPunch('out')}>{t('checkOut')}</button>
              <button className="ck-btn ck-btn-text" onClick={() => setConfirmOut(false)}>{t('notYetBtn')}</button>
            </div>
          </div>
        </div>
      )}

      {help && (
        <div className="ck-overlay ck-overlay-side" onClick={(e) => e.target === e.currentTarget && setHelp(false)}>
          <div className="ck-sheet" role="dialog" aria-modal="true" aria-label={t('help')}>
            <div className="ck-grabber" />
            <div className="ck-help-head"><h2>{t('help')}</h2><button className="ck-help-close" onClick={() => setHelp(false)}>{t('close')}</button></div>
            <div className="ck-how" role="note" data-testid="help-how">
              <div className="ck-how-head"><b>{t('howTitle')}</b></div>
              <ol>
                <li><span className="ck-how-num">1</span>{t('how1')}</li>
                <li><span className="ck-how-num">2</span>{t('how2')}</li>
                <li><span className="ck-how-num">3</span>{t('how3')}</li>
              </ol>
            </div>
            <Troubleshoot t={t} topic={helpTopic} setTopic={setHelpTopic} profileUrl={boot?.profileUrl} />
            <div className="ck-help-card ck-help-row"><b>{t('language')}</b><LangPills lang={lang} setLang={setLang} short /></div>
            <div className="ck-help-card ck-help-row">
              <b>{t('theme')}</b>
              <div className="ck-seg" role="group" aria-label={t('theme')}>
                {(['auto', 'light', 'dark'] as const).map((v) => (
                  <button key={v} className="ck-pill" aria-pressed={theme === v} onClick={() => setTheme(v)}>{t(v === 'auto' ? 'themeAuto' : v === 'light' ? 'themeLight' : 'themeDark')}</button>
                ))}
              </div>
            </div>
            {token && slug && me && (
              <div className="ck-help-card ck-help-row ck-signout">
                {confirmSignOut ? (
                  <>
                    <b className="ck-wrap">{t('signOutAsk')}</b>
                    <span className="ck-signout-actions">
                      <button className="ck-pill" onClick={() => setConfirmSignOut(false)} disabled={signingOut}>{t('cancel')}</button>
                      <button className="ck-pill ck-pill-danger" onClick={() => void signOutHere()} disabled={signingOut} data-testid="signout-yes">{signingOut ? t('oneMoment') : t('signOutYes')}</button>
                    </span>
                  </>
                ) : (
                  <>
                    <span className="ck-signout-who"><b>{me.person.name}</b><small className="ck-clip">{me.email}</small></span>
                    <button className="ck-pill" onClick={() => setConfirmSignOut(true)} data-testid="signout">{t('signOut')}</button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {toast && (
        <div className={`ck-toast${toast.error ? ' ck-toast-error' : ''}`} role="status" aria-live="polite">
          {toast.error ? <IconWarn size={18} /> : <IconCheck size={18} sw={2.6} />}<span className="ck-wrap">{toast.msg}</span>
        </div>
      )}
    </div>
  );
}

// ======================================================================== pieces

/** The school's logo from Amashuri; its initials while there is none or it fails to load. */
function SchoolMark({ initials, logoUrl, large }: { initials: string; logoUrl?: string | null; large?: boolean }) {
  const [broken, setBroken] = useState(false);
  const cls = `ck-logo${large ? ' ck-logo-lg' : ''}`;
  if (logoUrl && !broken) {
    return (
      <div className={`${cls} ck-logo-img`} aria-hidden="true">
        <img src={logoUrl} alt="" onError={() => setBroken(true)} />
      </div>
    );
  }
  return <div className={cls} aria-hidden="true">{initials}</div>;
}

type HelpTopic = 'gmail' | 'loc' | 'outside' | 'device' | 'nophone';

/** "My Gmail is not recognised": the address, then three visual steps and the shortcut. */
function NoAccountCard({ t, email, profileUrl }: { t: T; email: string; profileUrl?: string }) {
  return (
    <div className="ck-noacc" role="alert" data-testid="no-account">
      <div className="ck-noacc-mail"><IconMail size={18} /><span>{email}</span><em>{t('notRecognised')}</em></div>
      <ol className="ck-flow">
        <li><span className="ck-flow-ico"><IconUser size={18} /></span>{t('hGmail1')}</li>
        <li><span className="ck-flow-ico"><IconKeyboard size={18} /></span>{t('hGmail2')}</li>
        <li><span className="ck-flow-ico"><IconRetry size={18} /></span>{t('hGmail3')}</li>
      </ol>
      {profileUrl && <a className="ck-btn ck-btn-primary ck-btn-block" href={profileUrl} target="_blank" rel="noopener noreferrer">{t('openProfile')}</a>}
      <p className="ck-noacc-or">{t('tryAnother')}</p>
    </div>
  );
}

/** Help: pick what is happening, see the steps (icons, few words), act. */
function Troubleshoot({ t, topic, setTopic, profileUrl }: { t: T; topic: HelpTopic | null; setTopic: (v: HelpTopic | null) => void; profileUrl?: string }) {
  const topics: Array<{ key: HelpTopic; icon: React.ReactNode; title: string; steps: Array<[React.ReactNode, string]>; action?: React.ReactNode }> = [
    { key: 'gmail', icon: <IconMail size={20} />, title: t('hGmail'), steps: [[<IconUser size={16} />, t('hGmail1')], [<IconKeyboard size={16} />, t('hGmail2')], [<IconRetry size={16} />, t('hGmail3')]],
      action: profileUrl ? <a className="ck-btn ck-btn-primary ck-btn-block" href={profileUrl} target="_blank" rel="noopener noreferrer">{t('openProfile')}</a> : undefined },
    { key: 'loc', icon: <IconPinOff size={20} />, title: t('hLoc'), steps: [[<IconShield size={16} />, t('hLoc1')], [<IconCheck size={16} />, t('hLoc2')], [<IconPin size={16} />, t('hLoc3')]] },
    { key: 'outside', icon: <IconPin size={20} />, title: t('hOutside'), steps: [[<IconClock size={16} />, t('hOutside1')], [<IconWifi size={16} />, t('hOutside2')], [<IconHelp size={16} />, t('hOutside3')]] },
    { key: 'device', icon: <IconPhone size={20} />, title: t('hDevice'), steps: [[<IconPhone size={16} />, t('hDevice1')], [<IconDeviceOff size={16} />, t('hDevice2')], [<IconPhoneCheck size={16} />, t('hDevice3')]] },
    { key: 'nophone', icon: <IconQr size={20} />, title: t('hNoPhone'), steps: [[<IconQr size={16} />, t('hNoPhone1')], [<IconUser size={16} />, t('hNoPhone2')]] },
  ];
  return (
    <div className="ck-trouble">
      <div className="ck-trouble-pick">{t('helpPick')}</div>
      {topics.map((tp) => {
        const open = topic === tp.key;
        return (
          <div key={tp.key} className={`ck-trouble-item${open ? ' open' : ''}`}>
            <button className="ck-trouble-head" aria-expanded={open} onClick={() => setTopic(open ? null : tp.key)}>
              <span className="ck-trouble-ico">{tp.icon}</span>
              <span className="ck-trouble-title">{tp.title}</span>
              <span className="ck-trouble-chev"><IconChevron size={18} /></span>
            </button>
            {open && (
              <div className="ck-trouble-body">
                <ol className="ck-flow">
                  {tp.steps.map(([ico, text], i) => <li key={i}><span className="ck-flow-ico">{ico}</span>{text}</li>)}
                </ol>
                {tp.action}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function schoolInitials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

function registerErrorText(err: unknown, t: T, deviceWord: string): string {
  if (err instanceof OfflineError) return t('offlineHelp', { device: deviceWord });
  if (err instanceof ClockApiError) {
    switch (err.code) {
      case 'NO_ACCOUNT': return `${t('noAccount', { email: String(err.data.email ?? '') })} ${t('noAccountLead')}`;
      case 'STUDENT': return t('studentRefused');
      case 'DEVICE_TAKEN': return t('deviceTaken', { device: deviceWord });
      case 'GOOGLE_NOT_CONFIGURED': return t('googleNotSet');
      default: return err.message;
    }
  }
  return t('somethingWrong');
}

function LoadingScreen({ t }: { t: T }) {
  return (
    <main className="ck-screen" aria-busy="true" aria-label={t('loading')}>
      <div className="ck-topbar"><div className="ck-skel" style={{ width: 44, height: 44, borderRadius: 14 }} /><div className="ck-skel" style={{ flex: 1, height: 18, maxWidth: 220 }} /></div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, marginTop: 40 }}>
        <div className="ck-skel" style={{ width: 200, height: 20 }} />
        <div className="ck-skel" style={{ width: 160, height: 60 }} />
        <div className="ck-skel" style={{ width: 240, height: 240, borderRadius: 999, marginTop: 20 }} />
        <div className="ck-skel" style={{ width: 220, height: 34, borderRadius: 999, marginTop: 12 }} />
      </div>
      <div className="ck-grow" />
      <div className="ck-skel" style={{ height: 90, borderRadius: 20 }} />
    </main>
  );
}

function MessageScreen({ tone, icon, title, lead, extra, action }: { tone: 'blue' | 'amber' | 'red'; icon: React.ReactNode; title: string; lead: string; extra?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <main className="ck-screen ck-cardscreen">
      <div className="ck-card">
        <div className="ck-card-head">
          <div className={`ck-badge${tone === 'amber' ? ' ck-badge-amber' : tone === 'red' ? ' ck-badge-red' : ''}`}>{icon}</div>
          <h1>{title}</h1>
          {lead && <p>{lead}</p>}
        </div>
        {extra}
        <div className="ck-grow" />
        {action && <div className="ck-card-actions">{action}</div>}
      </div>
    </main>
  );
}

function DeniedScreen({ t, deviceWord, tablet, onRetry }: { t: T; deviceWord: string; tablet: boolean; onRetry: () => void }) {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  const browser = ios ? 'Safari' : 'Chrome';
  const steps = ios ? (['locStepIos1', 'locStepIos2', 'locStepIos3'] as const) : (['locStepChrome1', 'locStepChrome2', 'locStepChrome3'] as const);
  return (
    <main className="ck-screen ck-cardscreen">
      <div className="ck-card">
        <div className="ck-card-head">
          <div className="ck-badge ck-badge-amber"><IconPinOff size={42} /></div>
          <h1>{t('locationOff')}</h1>
          <p>{t('locationOffLead')}</p>
        </div>
        <div className="ck-howto">
          {!tablet && <div className="ck-howto-title">{t('onThisDevice', { device: deviceWord, browser })}</div>}
          <div className="ck-howto-steps" style={{ display: tablet ? undefined : 'flex', flexDirection: 'column', gap: 16 }}>
            {steps.map((k, i) => (
              <div className="ck-step" key={k}><span className="ck-num">{i + 1}</span><span>{t(k)}</span></div>
            ))}
          </div>
        </div>
        <div className="ck-grow" />
        <div className="ck-card-actions"><button className="ck-btn ck-btn-primary ck-btn-block" onClick={onRetry}>{t('turnedOn')}</button></div>
      </div>
    </main>
  );
}

function DeviceFact({ t, deviceWord }: { t: T; deviceWord: string }) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    void deviceInfo().then((i) => setLabel(`${i.model} · ${i.browser}`));
  }, []);
  return <div className="ck-fact"><span>{t('thisDevice', { device: deviceWord })}</span><b>{label || '…'}</b></div>;
}

function StatusChip({ t, status }: { t: T; status: string }) {
  const late = status === 'late';
  return (
    <span className="ck-status-chip" style={{ background: late ? 'var(--ck-amber-bg)' : 'var(--ck-green-bg)', color: late ? 'var(--ck-amber)' : 'var(--ck-green)' }}>
      <IconClock size={16} />{late ? t('lateChip') : t('onTimeChip')}
    </span>
  );
}

function LangPills({ lang, setLang, short = false }: { lang: Lang; setLang: (l: Lang) => void; short?: boolean }) {
  const items: Array<[Lang, string, string]> = [['en', 'English', 'EN'], ['rw', 'Kinyarwanda', 'RW'], ['fr', 'Français', 'FR']];
  return (
    <div className={short ? 'ck-seg' : 'ck-langs'} role="group" aria-label="Language">
      {items.map(([code, long, abbr]) => (
        <button key={code} className="ck-pill" aria-pressed={lang === code} onClick={() => setLang(code)} lang={code}>{short ? abbr : long}</button>
      ))}
    </div>
  );
}

interface DailyProps {
  t: T;
  deviceWord: string;
  tablet: boolean;
  me: Me;
  school: string;
  initials: string;
  logoUrl?: string | null;
  greeting: string;
  clockText: string;
  dateText: string;
  place: string;
  /** header icons that open my calendar and reminders */
  quickIcons?: React.ReactNode;
  /** a forgotten check-out: one button under the status */
  quickAlert?: React.ReactNode;
  /** the popups those open */
  quickSheets?: React.ReactNode;
  onCalendar: () => void;
  geoMode: GeoMode;
  seeking: number | null;
  weak: boolean;
  maxAccuracy: number;
  hint: ZoneHint | null;
  fix: Fix | null;
  serverOutside: number | null;
  offline: boolean;
  busy: 'in' | 'out' | null;
  locale: string;
  tz: string;
  showTip: boolean;
  onInstall: () => void;
  onHelp: () => void;
  onTap: () => void;
  /** a computer, or a phone whose location fails: offer "Use my phone" */
  phoneOffer: boolean;
  phonePanel: React.ReactNode;
  onPhone: () => void;
  onPhoneHide: () => void;
}

const hm = (t?: string | null): number | null => (t && /^\d\d:\d\d/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

/**
 * The daily screen, essentials only (mobile first): a quiet header (my calendar,
 * reminders, help), the school clock, one ring button whose ring is the person's
 * working day, one status line, and the week as seven small rings. Everything
 * else opens in a popup.
 */
function Daily(p: DailyProps) {
  const { t, me, deviceWord } = p;
  const v = dailyVisual(p);
  const nowM = hm(p.clockText);
  /** The share of an expected day (start to end) spent at school; a day still open counts up to now. */
  const share = (inT: string | null | undefined, outT: string | null | undefined, start: string | null | undefined, end: string | null | undefined, live: boolean): number => {
    const a = hm(inT);
    if (a == null) return 0;
    const b = hm(outT) ?? (live ? nowM : null);
    const s0 = hm(start);
    const e0 = hm(end);
    if (b == null || s0 == null || e0 == null || e0 <= s0) return 1;
    return Math.max(0.04, Math.min(1, (b - a) / (e0 - s0)));
  };
  const todayShare = me.today ? share(me.today.checkIn, me.today.checkOut, me.rules.lateAfter, me.rules.earlyLeaveBefore, true) : 0;

  // The seven days of this week: the person's working days come from the server, the others are days off.
  const monday = (() => {
    const d = new Date(`${me.schoolDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d;
  })();
  const letter = (date: string) => {
    try {
      return new Intl.DateTimeFormat(p.locale, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
    } catch {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
    }
  };
  const longDay = (date: string) => {
    try {
      return new Intl.DateTimeFormat(p.locale, { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
    } catch {
      return date;
    }
  };
  const week7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    const date = d.toISOString().slice(0, 10);
    const w = me.week.find((x) => x.date === date) ?? null;
    const isToday = date === me.schoolDate;
    const kind = !w ? 'off' : w.checkIn ? (w.status === 'late' ? 'late' : 'ok') : isToday ? 'today' : w.future ? 'next' : 'absent';
    const part = w ? share(w.checkIn, w.checkOut, w.start, w.end, isToday) : 0;
    const text = !w ? t('myHoursOff') : w.checkIn ? `${w.checkIn} – ${w.checkOut ?? '…'}` : w.future || isToday ? w.start ?? '' : t('calAbsentK');
    return { date, isToday, kind, part, name: letter(date), label: `${longDay(date)}: ${text}`, start: w?.start ?? null, end: w?.end ?? null, checkIn: w?.checkIn ?? null, checkOut: w?.checkOut ?? null };
  });
  // A day's details in a small popup: on hover or focus, and pinned by a tap (touch).
  const [dayOpen, setDayOpen] = useState<string | null>(null);
  const [dayPinned, setDayPinned] = useState(false);
  const weekRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!dayPinned) return;
    const away = (e: Event) => { if (!weekRef.current?.contains(e.target as Node)) { setDayPinned(false); setDayOpen(null); } };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setDayPinned(false); setDayOpen(null); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [dayPinned]);
  const openDay = dayOpen ? week7.find((d) => d.date === dayOpen) ?? null : null;
  const openAt = openDay ? week7.indexOf(openDay) : 0;
  const KIND_WORD = { ok: t('calOnTime'), late: t('calLateK'), absent: t('calAbsentK'), today: t('calTodayK'), next: t('calPlanned'), off: t('calOff') } as const;
  const dayDate = (date: string) => {
    try {
      return new Intl.DateTimeFormat(p.locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`));
    } catch {
      return date;
    }
  };
  const spent = (d: { checkIn: string | null; checkOut: string | null; isToday: boolean }) => {
    const a = hm(d.checkIn);
    const b = hm(d.checkOut) ?? (d.isToday ? nowM : null);
    return a != null && b != null && b > a ? `${Math.floor((b - a) / 60)} h ${String((b - a) % 60).padStart(2, '0')}` : null;
  };
  const done = me.week.filter((d) => d.checkIn).length;
  const late = me.week.filter((d) => d.status === 'late').length;
  const minutes = me.week.reduce((n, d) => {
    const a = hm(d.checkIn);
    const b = hm(d.checkOut) ?? (d.isToday ? nowM : null);
    return a != null && b != null && b > a ? n + (b - a) : n;
  }, 0);
  const hours = `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
  const C = 2 * Math.PI * 47;
  const c = 2 * Math.PI * 15;
  // On a computer the "Use my phone" card (or its QR panel) already says what to do: say it once.
  const helper = p.phonePanel || p.phoneOffer ? '' : v.helper;

  return (
    <main className="ck-screen ck-daily ck-e">
      <div className="ck-e-top">
        <SchoolMark initials={p.initials} logoUrl={p.logoUrl} />
        <b className="ck-e-hello ck-clip" title={p.school}>{p.greeting}</b>
        {p.quickIcons}
        <button className="ck-e-icon" onClick={p.onHelp} aria-label={t('help')} title={t('help')}><IconHelp size={23} /></button>
      </div>

      <div className="ck-e-gap" />

      <div className="ck-e-clock" aria-label={p.clockText}>{p.clockText}</div>
      <div className="ck-e-date">{p.dateText} · <span className="ck-e-place">{p.place}</span></div>

      <div className="ck-e-gap ck-e-gap-2" />

      {p.phonePanel ? (
        <section className="ck-action ck-action-phone ck-e-phone">
          {p.phonePanel}
          <button className="ck-link-btn" onClick={p.onPhoneHide}>{t('hide')}</button>
        </section>
      ) : (
        <>
          <div className="ck-e-ring">
            {/* The ring is the person's working day: it fills with the time at school. */}
            <svg aria-hidden="true" viewBox="0 0 100 100">
              <circle cx="50" cy="50" r="47" fill="none" className="ck-e-track" strokeWidth="2.6" />
              {todayShare > 0 && <circle cx="50" cy="50" r="47" fill="none" className="ck-e-prog" strokeWidth="2.6" strokeLinecap="round" strokeDasharray={`${(C * todayShare).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 50 50)" />}
            </svg>
            <button
              className={`ck-big${v.style === 'outline' ? ' ck-big-outline' : v.style === 'grey' ? ' ck-big-grey' : ''}`}
              onClick={p.onTap}
              disabled={v.disabled}
              aria-label={`${v.label}. ${v.sub}`}
              aria-busy={v.icon === 'spin'}
            >
              {v.icon === 'retry' && <IconRetry size={30} />}
              {v.icon === 'spin' && <span className="ck-spinner" />}
              <span className="ck-big-label">{v.label}</span>
              <span className="ck-big-sub">{v.sub}</span>
            </button>
          </div>
          <div className={`ck-e-note ck-e-note-${v.chipTone}`} aria-live="polite">{v.chip}</div>
          {helper && <p className="ck-e-help">{helper}</p>}
          {p.phoneOffer && (
            <button className="ck-phone-offer" onClick={p.onPhone} data-testid="use-phone">
              <span className="ck-phone-offer-icon"><IconQr size={20} /></span>
              <span className="ck-phone-offer-text"><b>{t('usePhone')}</b><small>{t('usePhoneHint')}</small></span>
            </button>
          )}
        </>
      )}
      {p.quickAlert}

      <div className="ck-e-gap ck-e-gap-3" />

      {p.showTip && (
        <div className="ck-tip">
          <IconAddHome />
          <span>{t('addHome')}</span>
          <button onClick={p.onInstall}>{t('add')}</button>
        </div>
      )}

      <div className="ck-e-week" role="group" aria-label={t('thisWeek')} ref={weekRef}>
        {openDay && (
          <div className="ck-e-pop" role="status" style={{ '--e-at': openAt } as React.CSSProperties} data-testid="day-pop">
            <b>{dayDate(openDay.date)}</b>
            <span className={`ck-e-pop-pill k-${openDay.kind}`}><i />{KIND_WORD[openDay.kind as keyof typeof KIND_WORD]}</span>
            {openDay.start && openDay.end && <span>{t('calExpected', { start: openDay.start, end: openDay.end })}</span>}
            {openDay.checkIn && <span>{t('calIn', { time: openDay.checkIn })}{openDay.checkOut ? ` · ${t('calOut', { time: openDay.checkOut })}` : ''}</span>}
            {spent(openDay) && <span className="ck-e-pop-strong">{spent(openDay)}</span>}
            {dayPinned && <button className="ck-e-pop-link" onClick={() => { setDayPinned(false); setDayOpen(null); p.onCalendar(); }}>{t('calTitle')}</button>}
          </div>
        )}
        {week7.map((d) => (
          <button key={d.date} className={`ck-e-day k-${d.kind}${d.isToday ? ' is-today' : ''}${dayOpen === d.date ? ' is-open' : ''}`} aria-label={d.label} aria-expanded={dayOpen === d.date}
            onPointerEnter={(e) => { if (e.pointerType === 'mouse' && !dayPinned) setDayOpen(d.date); }}
            onPointerLeave={(e) => { if (e.pointerType === 'mouse' && !dayPinned) setDayOpen(null); }}
            onFocus={() => { if (!dayPinned) setDayOpen(d.date); }}
            onBlur={() => { if (!dayPinned) setDayOpen(null); }}
            onClick={() => { const same = dayPinned && dayOpen === d.date; setDayPinned(!same); setDayOpen(same ? null : d.date); }}>
            <svg aria-hidden="true" viewBox="0 0 36 36">
              <circle cx="18" cy="18" r="15" fill="none" className="ck-e-dtrack" strokeWidth="3.5" />
              {d.part > 0 && <circle cx="18" cy="18" r="15" fill="none" className="ck-e-dprog" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={`${(c * d.part).toFixed(1)} ${c.toFixed(1)}`} transform="rotate(-90 18 18)" />}
            </svg>
            <span>{d.name}</span>
          </button>
        ))}
      </div>
      <div className="ck-e-total">
        <b>{t('daysOf', { done, total: me.week.length })}</b>
        {minutes > 0 && <> · {hours}</>}
        {late > 0 && <> · <span className="late">{t('weekLate', { n: late })}</span></>}
      </div>
      {p.quickSheets}
      <span className="ck-sr">{deviceWord}</span>
    </main>
  );
}

interface Visual {
  style: 'blue' | 'outline' | 'grey';
  icon: 'in' | 'out' | 'done' | 'retry' | 'spin';
  label: string;
  sub: string;
  pulse: boolean;
  disabled: boolean;
  chip: string;
  chipTone: 'green' | 'amber' | 'muted';
  helper: string;
}

function dailyVisual(p: DailyProps): Visual {
  const { t, me, geoMode, hint, busy, offline, tablet, deviceWord } = p;
  const today = me.today;
  const statusWord = today?.status === 'late' ? t('late') : t('onTime');
  const atSchoolChip = p.weak && p.fix ? t('weakChip', { accuracy: Math.round(p.fix.accuracy) }) : hint ? t('atSchoolDist', { distance: formatDistance(hint.distance) }) : t('atSchool');
  const okTone = p.weak ? 'amber' : 'green';
  const lateHelp = p.weak ? t('weakHelp') : me.dayOff ? t('dayOffAllowed') : me.rules.lateAfter ? t('lateAfter', { time: me.rules.lateAfter }) : '';

  if (me.next === 'done' && today) {
    return { style: 'grey', icon: 'done', label: t('doneToday'), sub: t('inOut', { in: today.checkIn ?? '', out: today.checkOut ?? '' }), pulse: false, disabled: true,
      chip: t('hoursAtSchool', { hours: fmtDuration(today.minutesAtSchool) }), chipTone: 'muted', helper: t('seeTomorrow') };
  }
  if (me.next === 'closed') {
    if (me.dayOffClosed) {
      // A day off: check-in is closed; say when they are next expected.
      const next = me.nextDay;
      const day = next ? new Date(`${next.date}T12:00:00Z`).toLocaleDateString(p.locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }) : '';
      return { style: 'grey', icon: 'in', label: t('dayOffTitle'), sub: t('closedToday'), pulse: false, disabled: true, chip: t('dayOffChip'), chipTone: 'muted',
        helper: next && next.start ? t('dayOffNext', { day, time: next.start }) : t('dayOffHelp') };
    }
    return { style: 'grey', icon: 'in', label: t('checkIn'), sub: t('closedToday'), pulse: false, disabled: true, chip: t('closedToday'), chipTone: 'muted',
      helper: me.schoolDay ? t('opensAt', { time: me.opensAt }) : t('notSchoolDay') };
  }

  const out = me.next === 'check_out';
  if (busy) {
    return { style: out ? 'outline' : 'blue', icon: 'spin', label: out ? t('checkingOut') : t('checkingIn'), sub: t('savingTime'), pulse: false, disabled: true,
      chip: atSchoolChip, chipTone: 'green', helper: '' };
  }
  if (offline) {
    return { style: 'blue', icon: 'retry', label: t('tryAgain'), sub: t('noInternet'), pulse: false, disabled: false, chip: t('noConnection'), chipTone: 'muted',
      helper: t('offlineHelp', { device: deviceWord }) };
  }
  if (out && me.checkoutOpensAt) {
    return { style: 'outline', icon: 'out', label: t('checkOut'), sub: t('checkoutOpens', { time: me.checkoutOpensAt }), pulse: false, disabled: true,
      chip: today ? t('checkedInAt', { time: today.checkIn ?? '', status: statusWord }) : '', chipTone: 'green', helper: me.rules.lateAfter ? t('lateAfter', { time: me.rules.lateAfter }) : '' };
  }
  if (geoMode === 'locating' || geoMode === 'idle') {
    const settling = p.seeking != null && p.seeking > p.maxAccuracy;
    return { style: out ? 'outline' : 'blue', icon: 'spin', label: t('findingYou'), sub: t('oneMoment'), pulse: !out, disabled: true,
      chip: settling ? t('gpsSettling', { accuracy: p.seeking as number }) : t('findingLocation'), chipTone: 'muted', helper: settling ? t('gpsSettlingHelp') : '' };
  }
  if (geoMode === 'outside') {
    const d = p.serverOutside ?? hint?.distance ?? null;
    return { style: 'grey', icon: out ? 'out' : 'in', label: out ? t('checkOut') : t('checkIn'), sub: t('notAtSchool'), pulse: false, disabled: false,
      chip: d != null ? t('youAreAway', { distance: formatDistance(d) }) : t('notAtSchool'), chipTone: 'amber', helper: t('opensWhenArrive') };
  }
  if (geoMode === 'vague' || geoMode === 'failed') {
    return { style: 'blue', icon: 'retry', label: t('tryAgain'), sub: t('findMyLocation'), pulse: false, disabled: false,
      chip: p.fix ? t('notPrecise', { accuracy: Math.round(p.fix.accuracy) }) : t('locNotFound'), chipTone: 'amber',
      helper: tablet ? t('notPreciseHelpTablet') : t('notPreciseHelpPhone') };
  }
  if (out) {
    return { style: 'outline', icon: 'out', label: t('checkOut'), sub: t('inSince', { time: today?.checkIn ?? '' }), pulse: false, disabled: false,
      chip: atSchoolChip, chipTone: okTone, helper: p.weak ? t('weakHelp') : today ? t('checkedInAt', { time: today.checkIn ?? '', status: statusWord }) : '' };
  }
  return { style: 'blue', icon: 'in', label: t('checkIn'), sub: t('tapOnce'), pulse: true, disabled: false, chip: atSchoolChip, chipTone: okTone,
    helper: lateHelp };
}

export type { DayState };
