'use strict';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || '';

function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

/** Headers de autenticación para todas las llamadas a Supabase REST. */
function headers(extra = {}) {
  return {
    'apikey':        SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
    'Accept':        'application/json',
    ...extra,
  };
}

/**
 * Fetch conveniente contra Supabase REST.
 * @param {string} path  - e.g. 'positions?select=ticker,qty'
 * @param {object} opts  - mismo objeto que fetch() excepto que headers ya se inyectan
 * @returns {Promise<any>} - body parseado como JSON
 * @throws si el status no es 2xx
 */
async function sb(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1/${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: headers(opts.headers || {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${res.status}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

module.exports = { SUPABASE_URL, SUPABASE_KEY, isConfigured, headers, sb };
