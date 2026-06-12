/* nhost.js — optional backend scaffolding for Free PDF Suite.
 *
 * The PDF tools are 100% client-side and need NO backend. This module wires
 * in the Nhost SDK so that Authentication, Postgres (GraphQL), Storage or
 * Functions can be switched on later without touching the app code.
 *
 * To activate:
 *   1. Create / link a project at https://app.nhost.io (or `nhost init`).
 *   2. Replace NHOST_CONFIG below with your project's subdomain + region.
 *   3. Call `await window.getNhost()` anywhere — e.g. nhost.auth.signIn(...).
 *
 * While the placeholder config is in place this module makes ZERO network
 * requests and adds ZERO bytes of SDK download for visitors.
 */
'use strict';

const NHOST_CONFIG = {
  subdomain: 'YOUR_NHOST_SUBDOMAIN', // e.g. 'abcdefghijklmnop'
  region: 'ap-southeast-1',          // matches your Nhost project region
};

const isConfigured = () => !NHOST_CONFIG.subdomain.startsWith('YOUR_');

let _client = null;

/** Lazily load the Nhost SDK from CDN and return a singleton client (or null). */
export async function getNhost() {
  if (!isConfigured()) {
    console.info('[nhost] Backend not configured — running in pure client-side mode. ' +
      'Edit nhost.js to enable Auth / Database / Storage.');
    return null;
  }
  if (_client) return _client;
  const { NhostClient } = await import('https://cdn.jsdelivr.net/npm/@nhost/nhost-js@3/+esm');
  _client = new NhostClient(NHOST_CONFIG);
  return _client;
}

// Convenience handle for non-module scripts (app.js) and the dev console.
window.getNhost = getNhost;
