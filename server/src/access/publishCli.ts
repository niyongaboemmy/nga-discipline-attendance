import { config } from '../config.js';
import { publishManifest } from './publish.js';

/** `npm run access:publish` (dev) / `node dist/access/publishCli.js` (deploy). */
publishManifest({
  misBaseUrl: config.ngaMisBaseUrl,
  clientId: config.ssoClientId,
  clientSecret: config.ssoClientSecret,
})
  .then((body) => {
    console.log('[access] manifest published:', JSON.stringify(body, null, 2));
  })
  .catch((err) => {
    console.error(`[access] manifest publish failed: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  });
