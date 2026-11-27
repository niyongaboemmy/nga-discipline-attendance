import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Printer } from 'lucide-react';
import { DashboardLayout } from '../../components/Layout/DashboardLayout';
import { ErrorState } from '../../components/common/ErrorState';
import { ApiError } from '../../api/client';
import { staffClockApi, type ClockConfig } from '../../api/staffClock';
import { StaffClockHeader } from './StaffClockHeader';
import { PrintLetterhead, supportsMarginBoxes } from '../../components/common/PrintLetterhead';
import { currentLetterhead, loadLetterhead } from '../../utils/documentLetterhead.ts';
import { SC_SHEET_PAGE_CSS, SC_SHEET_SIDE_MM, sheetContentHeightMm } from './sheetPage.ts';

/** The A4 staffroom poster: the school's staff link as a real QR code + three steps. */
export const StaffClockPoster: React.FC = () => {
  const [cfg, setCfg] = useState<ClockConfig | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The school's letterhead goes in the paper's margins: the poster keeps its design and
  // is only as tall as the room left between the header and the footer (still one sheet).
  const [lh, setLh] = useState(currentLetterhead);
  useEffect(() => {
    let alive = true;
    void loadLetterhead().then((l) => alive && setLh(l));
    return () => { alive = false; };
  }, []);
  const printHeight = `${sheetContentHeightMm(lh, supportsMarginBoxes())}mm`;

  useEffect(() => {
    staffClockApi
      .config()
      .then(async (c) => {
        setCfg(c);
        setQr(await QRCode.toDataURL(c.link.url, { errorCorrectionLevel: 'M', margin: 1, width: 600 }));
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load the staff link.'));
  }, []);

  const name = cfg?.school.name ?? '';
  const words = name.split(/\s+/).filter(Boolean);
  const initials = (words.length === 1 ? words[0].slice(0, 3) : words.slice(0, 3).map((w) => w[0]).join('')).toUpperCase();

  return (
    <DashboardLayout>
      <style>{SC_SHEET_PAGE_CSS}</style>
      <PrintLetterhead letterhead={lh} note="Staff attendance poster · Tendo · Amashuri" sideMm={SC_SHEET_SIDE_MM} />
      <div className="sc-page">
        <StaffClockHeader title="Staffroom poster" lead="Print it on A4 and put it where staff arrive." actions={<button className="sc-btn sc-btn-primary" onClick={() => { void staffClockApi.saveRules({ setupDone: ['shared'] }).catch(() => undefined); window.print(); }} disabled={!qr}><Printer size={16} /> Print</button>} />
        {error && <ErrorState message={error} />}
        {!cfg && !error && <div className="sc-skel" style={{ width: 595, maxWidth: '100%', aspectRatio: '595 / 842', margin: '0 auto' }} />}
        {cfg && (
          <div className="sc-print">
            <div className="sc-poster" style={{ ['--sc-poster-print-height' as string]: printHeight }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 48, height: 48, borderRadius: 16, background: '#2563eb', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 14 }}>{initials}</div>
                <span style={{ fontSize: 17, fontWeight: 600, color: '#374151' }}>{name}</span>
              </div>
              <h1>Staff attendance</h1>
              <p style={{ margin: '10px 0 0', fontSize: 18, color: '#4b5563' }}>Check in and out with your own phone</p>
              <div className="sc-poster-qr">{qr ? <img src={qr} alt={`QR code for ${cfg.link.url}`} /> : <div style={{ width: 225, height: 225 }} />}</div>
              <div style={{ marginTop: 14, fontSize: 20, fontWeight: 700, color: '#1d4ed8', overflowWrap: 'anywhere' }}>{cfg.link.display}</div>
              <div className="sc-poster-steps">
                {[
                  ['Scan the code', 'With your phone camera'],
                  ['Continue with Google', 'Once, to register your phone'],
                  ['Tap every day', 'Check in on arrival, out when you leave'],
                ].map(([t, d], i) => (
                  <div key={t}>
                    <span>{i + 1}</span>
                    <div style={{ marginTop: 10, fontSize: 15, fontWeight: 600 }}>{t}</div>
                    <div style={{ marginTop: 4, fontSize: 13, lineHeight: '18px', color: '#4b5563' }}>{d}</div>
                  </div>
                ))}
              </div>
              <div style={{ flex: 1 }} />
              <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: '#4b5563' }}>For teachers and staff only. Works inside the school grounds.<br />No smartphone? Ask the office for a staff QR card.</p>
              <div style={{ marginTop: 14, fontSize: 12, color: '#6b7280' }}>Amashuri · Tendo</div>
            </div>
          </div>
        )}
      </div>
    </DashboardLayout>
  );
};
