import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildPublishRequest, publishManifest } from '../access/publish.js';
import { DA_MANIFEST } from '../access/manifest.js';
import { validateManifest } from '../vendor/nga-access/index.js';

const env = { misBaseUrl: 'https://mis.example/', clientId: 'discipline_attendance', clientSecret: 's3:cret' };

describe('access:publish', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a PUT of the manifest to /access/manifests/da with Basic client credentials', () => {
    const { url, init } = buildPublishRequest(env);
    expect(url).toBe('https://mis.example/access/manifests/da');
    expect(init.method).toBe('PUT');
    expect(init.headers.Authorization).toBe(`Basic ${Buffer.from('discipline_attendance:s3:cret').toString('base64')}`);
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body).toEqual(JSON.parse(JSON.stringify(DA_MANIFEST)));
    expect(validateManifest(body)).toEqual([]);
  });

  it('refuses placeholder credentials, a missing MIS URL and an invalid manifest', () => {
    expect(() => buildPublishRequest({ ...env, clientId: 'placeholder_client_id' })).toThrow(/SSO_CLIENT_ID/);
    expect(() => buildPublishRequest({ ...env, clientSecret: '' })).toThrow(/SSO_CLIENT_SECRET/);
    expect(() => buildPublishRequest({ ...env, misBaseUrl: '' })).toThrow(/NGA_MIS_BASE_URL/);
    expect(() => buildPublishRequest(env, { ...DA_MANIFEST, app: 'DA!' } as any)).toThrow(/manifest/);
  });

  it('returns the MIS body on success and rejects on an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true, data: { unchanged: true } }), { status: 200 })));
    await expect(publishManifest(env)).resolves.toMatchObject({ data: { unchanged: true } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"success":false}', { status: 403 })));
    await expect(publishManifest(env)).rejects.toThrow(/403/);
  });
});
