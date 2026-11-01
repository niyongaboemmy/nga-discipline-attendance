import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Copy, ExternalLink } from 'lucide-react';
import { handoffDestination, type HandoffPayload, type HandoffTarget } from './handoff';

/**
 * "Open in my AI ▾" + "Paste the answer" (EXTERNAL_AI_CONTRACT.md §1 UI).
 *
 * The person's own Claude / ChatGPT / Gemini can never be called by Tendo, so
 * we hand them the exact prompt instead: prefilled in a new tab when it fits a
 * link (never auto-submitted), otherwise copied to the clipboard. They paste
 * the reply back and it goes through the same checks as a school AI answer.
 */

export type { HandoffPayload } from './handoff';

const TARGETS: { key: HandoffTarget; label: string }[] = [
  { key: 'claude', label: 'Claude' },
  { key: 'chatgpt', label: 'ChatGPT' },
  { key: 'gemini', label: 'Gemini' },
  { key: 'copy', label: 'Copy the prompt' },
];

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

interface Props {
  /** Calls the AI endpoint in prompt mode and returns its hand-off. */
  requestPrompt: (pupilConsent: boolean) => Promise<HandoffPayload>;
  /** Calls the endpoint in import mode with the pasted answer; throws to show an error. */
  importAnswer: (text: string) => Promise<void>;
  /** The prompt can include pupils' details: offer "Include pupil details" (unticked). */
  pupilData?: boolean;
  disabled?: boolean;
}

export const HandoffControl: React.FC<Props> = ({ requestPrompt, importAnswer, pupilData, disabled }) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<{ payload: HandoffPayload; url: string | null; copied: boolean } | null>(null);
  const [answer, setAnswer] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const open = async (target: HandoffTarget) => {
    setMenuOpen(false);
    setError(null);
    setBusy(true);
    try {
      const payload = await requestPrompt(consent);
      const dest = handoffDestination(target, payload.prompt);
      const copied = dest.copy ? await copyText(payload.prompt) : false;
      if (dest.url) window.open(dest.url, '_blank', 'noopener,noreferrer');
      setHandoff({ payload, url: dest.url, copied });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not prepare the prompt.');
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!answer.trim()) return;
    setError(null);
    setBusy(true);
    try {
      await importAnswer(answer);
      setAnswer('');
      setHandoff(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not use that answer.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="handoff" ref={ref} style={{ position: 'relative' }}>
      <div className="flex flex-wrap items-center gap-2">
        {pupilData && (
          <label className="text-xs text-secondary flex items-center gap-1">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} disabled={busy} />
            Include pupil details
          </label>
        )}
        <button
          type="button"
          className="btn btn-outline btn-sm"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          disabled={disabled || busy}
          onClick={() => setMenuOpen((v) => !v)}
        >
          Open in my AI <ChevronDown size={14} />
        </button>
      </div>
      {menuOpen && (
        <div className="menu menu--right" role="menu">
          {TARGETS.map((t) => (
            <button key={t.key} type="button" role="menuitem" className="menu-item" onClick={() => open(t.key)}>
              {t.key === 'copy' ? <Copy size={14} /> : <ExternalLink size={14} />} {t.label}
            </button>
          ))}
        </div>
      )}
      {handoff && (
        <div className="field mt-2">
          <p className="text-xs text-secondary">
            {handoff.url
              ? handoff.copied
                ? 'The prompt is copied: paste it into the chat that opened, send it, then paste the reply here.'
                : 'Send the prompt in the chat that opened, then paste the whole reply here.'
              : handoff.copied
                ? 'The prompt is copied. Paste it into your AI, then paste the whole reply here.'
                : 'Copy the prompt below into your AI, then paste the whole reply here.'}{' '}
            {handoff.url && (
              <a href={handoff.url} target="_blank" rel="noopener noreferrer">Open again ↗</a>
            )}
          </p>
          {!handoff.copied && !handoff.url && (
            <textarea className="textarea" rows={3} readOnly value={handoff.payload.prompt} aria-label="The prompt for your AI" />
          )}
          {!handoff.copied && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(handoff.payload.prompt)}>
              <Copy size={14} /> Copy the prompt
            </button>
          )}
          <label className="label" htmlFor="handoff-answer">Paste the answer</label>
          <textarea
            id="handoff-answer"
            className="textarea"
            rows={4}
            value={answer}
            placeholder={handoff.payload.expects === 'json' ? 'Paste the whole reply, including the ```json block' : 'Paste the reply'}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <div className="flex gap-2 mt-2">
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !answer.trim()} onClick={submit}>
              {busy ? 'Checking…' : 'Use this answer'}
            </button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setHandoff(null); setAnswer(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-danger mt-1" role="alert">{error}</p>}
    </div>
  );
};
