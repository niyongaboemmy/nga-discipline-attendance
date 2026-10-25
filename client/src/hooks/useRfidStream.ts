import { useEffect, useRef, useState } from 'react';
import type { RfidStreamEvent } from '../api/rfid';

export type StreamState = 'connecting' | 'live' | 'reconnecting' | 'off';

/**
 * Live check-in events from /api/rfid/stream (Server-Sent Events).
 *
 * Read with fetch() rather than EventSource so the session token travels in
 * the Authorization header instead of the URL (URLs end up in proxy logs).
 * After a drop it reconnects with backoff, and fires `onReconnect` so the
 * page can refetch whatever it missed while offline.
 */
export function useRfidStream(
  onEvent: (e: RfidStreamEvent) => void,
  opts: { enabled?: boolean; onReconnect?: () => void } = {}
): StreamState {
  const { enabled = true } = opts;
  const [state, setState] = useState<Exclude<StreamState, 'off'> | 'denied'>('connecting');
  // Latest callbacks without resubscribing on every render.
  const handler = useRef(onEvent);
  const reconnect = useRef(opts.onReconnect);
  handler.current = onEvent;
  reconnect.current = opts.onReconnect;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      controller = new AbortController();
      const token = localStorage.getItem('sso_token');
      try {
        const res = await fetch('/api/rfid/stream', {
          headers: token ? { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } : {},
          signal: controller.signal,
        });
        if (res.status === 401 || res.status === 403) { setState('denied'); return; }
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        if (attempt > 0) reconnect.current?.();
        attempt = 0;
        setState('live');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            const data = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
            if (!data || data === '{}') continue;
            try { handler.current(JSON.parse(data)); } catch { /* ignore a malformed frame */ }
          }
        }
        throw new Error('stream ended');
      } catch {
        if (stopped) return;
        setState('reconnecting');
        attempt += 1;
        timer = setTimeout(connect, Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)));
      }
    };

    void connect();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [enabled]);

  return !enabled || state === 'denied' ? 'off' : state;
}
