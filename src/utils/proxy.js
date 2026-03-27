/**
 * proxy.js
 * Proxy support for Polymarket API calls only.
 *
 * - CLOB API: uses axios internally (via @polymarket/clob-client) →
 *   we set axios.defaults.httpAgent/httpsAgent via https-proxy-agent.
 * - Gamma / Data API: uses native fetch (undici) →
 *   we use undici.ProxyAgent with the `dispatcher` option.
 * - Polygon RPC: NOT proxied (separate ethers.js provider).
 *
 * Set PROXY_URL in .env to enable. Supports HTTP/HTTPS proxies.
 * Example: PROXY_URL=http://user:pass@proxy.example.com:8080
 */

import config from '../config/index.js';
import logger from './logger.js';

let axiosAgent = null;   // https-proxy-agent for axios (CLOB client)
let fetchDispatcher = null; // undici ProxyAgent for native fetch

/**
 * Set up axios defaults so that the @polymarket/clob-client's
 * internal axios calls go through the proxy.
 * Call this BEFORE creating ClobClient.
 */
export async function setupAxiosProxy() {
    if (!config.proxyUrl) {
        logger.info('No PROXY_URL set — Polymarket API calls will be direct');
        return;
    }

    try {
        // 1. Setup axios proxy (for CLOB client)
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        axiosAgent = new HttpsProxyAgent(config.proxyUrl);

        const axiosModule = await import('axios');
        const axios = axiosModule.default || axiosModule;
        axios.defaults.proxy = false;
        axios.defaults.httpAgent = axiosAgent;
        axios.defaults.httpsAgent = axiosAgent;

        // Add request interceptor to force proxy agent on every request
        // This catches cases where axios.create() instances ignore defaults
        axios.interceptors.request.use((cfg) => {
            if (cfg.url && cfg.url.includes('polymarket.com')) {
                cfg.httpsAgent = axiosAgent;
                cfg.httpAgent = axiosAgent;
                cfg.proxy = false;
            }
            return cfg;
        });

        logger.info(`Axios proxy configured → ${maskProxyUrl(config.proxyUrl)}`);
    } catch (err) {
        logger.error(`Failed to configure axios proxy: ${err.message}`);
        logger.error('Make sure https-proxy-agent is installed: npm i https-proxy-agent');
    }

    try {
        // 2. Setup undici ProxyAgent (for native fetch)
        const undici = await import('undici');
        fetchDispatcher = new undici.ProxyAgent(config.proxyUrl);
        logger.info(`Fetch proxy configured → ${maskProxyUrl(config.proxyUrl)}`);
    } catch (err) {
        logger.error(`Failed to configure fetch proxy: ${err.message}`);
    }
}

/**
 * Proxy-aware fetch wrapper.
 * Drop-in replacement for global fetch() — uses undici ProxyAgent
 * as dispatcher when PROXY_URL is configured.
 * Use this for Gamma API and Data API calls.
 */
export async function proxyFetch(url, opts = {}) {
    if (fetchDispatcher) {
        opts.dispatcher = fetchDispatcher;
    }
    return fetch(url, opts);
}

/**
 * Check the outbound IP address that Polymarket sees.
 * Uses both direct and proxied requests so you can compare.
 */
async function checkOutboundIP() {
    const IP_SERVICE = 'https://api.ipify.org?format=json';
    const GEOBLOCK_API = 'https://polymarket.com/api/geoblock';

    // 1. Check VPS direct IP
    try {
        const directResp = await fetch(IP_SERVICE, { signal: AbortSignal.timeout(10000) });
        if (directResp.ok) {
            const data = await directResp.json();
            logger.info(`VPS direct IP : ${data.ip}`);
        }
    } catch {
        logger.warn('Could not detect VPS direct IP');
    }

    // 2. Check if VPS direct IP is geoblocked
    try {
        const geoResp = await fetch(GEOBLOCK_API, { signal: AbortSignal.timeout(10000) });
        if (geoResp.ok) {
            const geo = await geoResp.json();
            if (geo.blocked) {
                logger.warn(`VPS direct IP GEOBLOCKED — country: ${geo.country}, region: ${geo.region}`);
            } else {
                logger.info(`VPS direct IP NOT geoblocked — country: ${geo.country}`);
            }
        }
    } catch {
        logger.warn('Could not check VPS geoblock status');
    }

    // 3. Check proxied IP (what Polymarket will see)
    if (fetchDispatcher) {
        try {
            const proxyResp = await fetch(IP_SERVICE, {
                dispatcher: fetchDispatcher,
                signal: AbortSignal.timeout(10000),
            });
            if (proxyResp.ok) {
                const data = await proxyResp.json();
                logger.info(`Proxy IP      : ${data.ip} ← Polymarket sees this`);
            }
        } catch {
            logger.warn('Could not detect proxy IP — proxy may not be working');
        }

        // 4. Check if proxy IP is geoblocked
        try {
            const geoResp = await fetch(GEOBLOCK_API, {
                dispatcher: fetchDispatcher,
                signal: AbortSignal.timeout(10000),
            });
            if (geoResp.ok) {
                const geo = await geoResp.json();
                if (geo.blocked) {
                    logger.error('═══════════════════════════════════════════════════');
                    logger.error(`PROXY IP GEOBLOCKED by Polymarket!`);
                    logger.error(`IP: ${geo.ip} | Country: ${geo.country} | Region: ${geo.region}`);
                    logger.error('Change PROXY_URL in .env to a proxy in an allowed region.');
                    logger.error('═══════════════════════════════════════════════════');
                } else {
                    logger.success(`Proxy IP NOT geoblocked — country: ${geo.country} ✓`);
                }
            }
        } catch {
            logger.warn('Could not check proxy geoblock status');
        }
    }
}

/**
 * Test that the proxy works and is not geoblocked by Polymarket CLOB.
 * Call this at startup to fail fast if the proxy is misconfigured.
 */
export async function testProxy() {
    if (!config.proxyUrl) return true; // no proxy = nothing to test

    logger.info(`Testing proxy connection → ${maskProxyUrl(config.proxyUrl)} ...`);

    // Show both IPs so user can verify which IP Polymarket sees
    await checkOutboundIP();

    // ── Test 1: fetch (undici) ──────────────────────────────────────────
    try {
        if (!fetchDispatcher) {
            throw new Error('Proxy dispatcher not initialized');
        }

        const resp = await fetch(`${config.clobHost}/time`, {
            dispatcher: fetchDispatcher,
            signal: AbortSignal.timeout(15000),
        });

        if (resp.status === 403) {
            const body = await resp.text().catch(() => '');
            const isGeoblock = body.includes('restricted') || body.includes('region') || body.includes('geoblock');
            if (isGeoblock) {
                logger.error('═══════════════════════════════════════════════════');
                logger.error('GEOBLOCKED — Polymarket CLOB rejected your proxy IP!');
                logger.error('Your proxy IP is in a restricted region.');
                logger.error('Change PROXY_URL in .env to a proxy in an allowed region.');
                logger.error('Allowed regions: https://docs.polymarket.com/developers/CLOB/geoblock');
                logger.error('═══════════════════════════════════════════════════');
            } else {
                logger.error(`CLOB returned 403 Forbidden: ${body.substring(0, 200)}`);
            }
            return false;
        }

        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
        }

        logger.success(`Proxy test (fetch) passed`);
    } catch (err) {
        logger.error(`Proxy test (fetch) FAILED: ${err.message}`);
        logger.error('Check PROXY_URL in .env. Bot cannot reach Polymarket without a working proxy.');
        return false;
    }

    // ── Test 2: axios (same transport as CLOB client) ────────────────────
    try {
        if (!axiosAgent) {
            throw new Error('Axios proxy agent not initialized');
        }

        const axiosModule = await import('axios');
        const axios = axiosModule.default || axiosModule;
        const axiosResp = await axios.get(`${config.clobHost}/time`, {
            httpsAgent: axiosAgent,
            proxy: false,
            timeout: 15000,
        });

        logger.success(`Proxy test (axios) passed`);
    } catch (err) {
        const status = err?.response?.status;
        const data = err?.response?.data;

        if (status === 403) {
            const body = typeof data === 'string' ? data : JSON.stringify(data || '');
            const isGeoblock = body.includes('restricted') || body.includes('region') || body.includes('geoblock');
            if (isGeoblock) {
                logger.error('═══════════════════════════════════════════════════');
                logger.error('GEOBLOCKED (axios) — Polymarket CLOB rejected your proxy IP!');
                logger.error('Your proxy IP is in a restricted region.');
                logger.error('The CLOB client uses axios — this test confirms proxy routing.');
                logger.error('Change PROXY_URL in .env to a proxy in an allowed region.');
                logger.error('═══════════════════════════════════════════════════');
            } else {
                logger.error(`CLOB returned 403 via axios: ${body.substring(0, 200)}`);
            }
            return false;
        }

        logger.error(`Proxy test (axios) FAILED: ${err.message}`);
        return false;
    }

    logger.success(`All proxy tests passed — connected via ${maskProxyUrl(config.proxyUrl)}`);
    return true;
}

/**
 * Mask credentials in proxy URL for safe logging.
 * http://user:pass@host:port → http://***:***@host:port
 */
function maskProxyUrl(url) {
    try {
        const u = new URL(url);
        if (u.username || u.password) {
            u.username = '***';
            u.password = '***';
        }
        return u.toString();
    } catch {
        return '(invalid URL)';
    }
}
