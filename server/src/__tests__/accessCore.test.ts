import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  AccessSnapshot, decide, depthSatisfies, groupByAllowed, scopeFor, suppressSmallCohorts, validateManifest,
} from '../vendor/nga-access/index.js';
import { DA_MANIFEST } from '../access/manifest.js';
import { PERMISSIONS, DEFAULT_ROLE_PERMISSIONS } from '../constants/permissions.js';

/**
 * The shared @nga/access decision table, run against this app's vendored
 * copy of the core (packages/access README §1). Re-vendor with
 *   node nga_central_mis/packages/access/sync.mjs server/src/vendor/nga-access
 */
const VENDOR = path.resolve(__dirname, '../vendor/nga-access');
const table = JSON.parse(fs.readFileSync(path.join(VENDOR, 'decision-table.json'), 'utf8'));
const snapshot = table.snapshot as AccessSnapshot;

describe('@nga/access vendored copy', () => {
  it('matches its sha256 provenance header (never edit the copy)', () => {
    const vendored = fs.readFileSync(path.join(VENDOR, 'index.ts'), 'utf8');
    const lines = vendored.split('\n');
    const m = /^\/\/ sha256:([0-9a-f]{64})$/.exec(lines[2]);
    expect(m).not.toBeNull();
    const core = lines.slice(3).join('\n');
    expect(createHash('sha256').update(core).digest('hex')).toBe(m![1]);
  });

  // When the MIS monorepo is checked out next to this repo, also check the
  // copy is the current one (skipped in CI / on the server).
  const pkg = path.resolve(__dirname, '../../../../nga_central_mis/packages/access');
  it.skipIf(!fs.existsSync(path.join(pkg, 'src/index.ts')))('is the current packages/access core', () => {
    const core = fs.readFileSync(path.join(pkg, 'src/index.ts'), 'utf8');
    const vendored = fs.readFileSync(path.join(VENDOR, 'index.ts'), 'utf8');
    expect(vendored.endsWith(core)).toBe(true);
    expect(fs.readFileSync(path.join(VENDOR, 'decision-table.json'), 'utf8'))
      .toBe(fs.readFileSync(path.join(pkg, 'test/decision-table.json'), 'utf8'));
  });
});

describe('@nga/access decision table', () => {
  for (const c of table.cases) {
    it(c.name, () => {
      const d = decide(snapshot, c.cap, c.target, c.minDepth ?? null);
      expect(d.allowed).toBe(c.allowed);
      if ('depth' in c) expect(d.depth).toEqual(c.depth);
      if ('via' in c) expect(d.via).toEqual(c.via);
    });
  }
  for (const c of table.scopeFor) {
    it(`scopeFor: ${c.name}`, () => {
      expect(scopeFor(snapshot, c.cap, c.minDepth ?? null)).toEqual(c.expect);
    });
  }
  it('fails closed on a missing snapshot', () => {
    expect(decide(null, 'DISCIPLINE_VIEW_ALL', {}).allowed).toBe(false);
    expect(scopeFor(undefined, 'DISCIPLINE_VIEW_ALL')).toBeNull();
  });
  it('helpers behave', () => {
    expect(depthSatisfies('sensitive', 'detail')).toBe(true);
    expect(depthSatisfies('summary', 'detail')).toBe(false);
    expect(groupByAllowed('summary', 'STUDENT')).toBe(false);
    expect(suppressSmallCohorts([{ key: 'a', n: 3, value: 1 }], 5)[0]).toMatchObject({ suppressed: true, value: null });
  });
});

describe('D&A capability manifest', () => {
  const NEW_KEYS = [
    'DISCIPLINE_SANCTION_MINOR', 'DISCIPLINE_SANCTION_MAJOR',
    'DISCIPLINE_SUSPEND_RECOMMEND', 'DISCIPLINE_SUSPEND_APPROVE',
  ];

  it('is valid', () => {
    expect(validateManifest(DA_MANIFEST)).toEqual([]);
    expect(DA_MANIFEST.app).toBe('da');
  });

  it('declares exactly the local permission catalog (no drift either way)', () => {
    const manifestKeys = Object.keys(DA_MANIFEST.capabilities).sort();
    const catalogKeys = PERMISSIONS.map((p) => p.key).sort();
    expect(manifestKeys).toEqual(catalogKeys);
    for (const k of NEW_KEYS) expect(manifestKeys).toContain(k);
  });

  it('seeds the sanction-ladder keys to Admin only (legacy behaviour unchanged)', () => {
    for (const k of NEW_KEYS) {
      expect(DEFAULT_ROLE_PERMISSIONS.Admin).toContain(k);
      expect(DEFAULT_ROLE_PERMISSIONS.Teacher).not.toContain(k);
      expect(DEFAULT_ROLE_PERMISSIONS.Student).not.toContain(k);
    }
  });
});
