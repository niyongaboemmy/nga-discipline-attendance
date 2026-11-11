import { __setTenants, primaryTenantCtx } from '../tenancy/index.js';

// Tests never ask a real MIS for the tenant list: tenant 1 only, unless a
// test installs its own list with __setTenants().
__setTenants([primaryTenantCtx()]);
