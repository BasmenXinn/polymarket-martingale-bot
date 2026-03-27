/**
 * patch-clob-client.cjs
 *
 * Patches @polymarket/clob-client to inject proxy support.
 * Runs automatically via `npm install` (postinstall hook).
 *
 * What it does:
 *   - Adds HttpsProxyAgent import to http-helpers/index.js
 *   - Registers an axios interceptor that injects the proxy agent
 *     into every request to polymarket.com
 *   - Reads PROXY_URL from process.env at runtime
 */

const fs = require('fs');
const path = require('path');

const TARGET = path.join(
    __dirname,
    '..',
    'node_modules',
    '@polymarket',
    'clob-client',
    'dist',
    'http-helpers',
    'index.js',
);

if (!fs.existsSync(TARGET)) {
    console.log('[patch] @polymarket/clob-client not found — skipping');
    process.exit(0);
}

let code = fs.readFileSync(TARGET, 'utf8');

// Check if already patched
if (code.includes('getProxyAgent')) {
    console.log('[patch] @polymarket/clob-client already patched — skipping');
    process.exit(0);
}

// ── Inject proxy interceptor after axios import ─────────────────────────────
// Instead of patching individual request configs (which causes circular
// reference errors when the config gets serialized), we register an axios
// request interceptor that injects httpsAgent on the fly.

const PATCH_CODE = `
// ── Proxy support (auto-patched by scripts/patch-clob-client.cjs) ──────────
const https_proxy_agent_1 = require("https-proxy-agent");
let _cachedProxyAgent = null;
const getProxyAgent = () => {
    if (!process.env.PROXY_URL) return undefined;
    if (!_cachedProxyAgent) {
        _cachedProxyAgent = new https_proxy_agent_1.HttpsProxyAgent(process.env.PROXY_URL);
    }
    return _cachedProxyAgent;
};
// Intercept all axios requests — inject proxy agent for polymarket.com
axios_1.default.interceptors.request.use(function(cfg) {
    if (cfg.url && cfg.url.includes('polymarket.com')) {
        var agent = getProxyAgent();
        if (agent) {
            cfg.httpsAgent = agent;
            cfg.httpAgent = agent;
            cfg.proxy = false;
        }
    }
    return cfg;
});
// ── End proxy patch ────────────────────────────────────────────────────────
`;

// Find axios import to inject after — try multiple patterns
const axiosPatterns = [
    // tslib __importDefault pattern (compiled TS)
    /tslib_1\.__importDefault\s*\(\s*require\s*\(\s*["']axios["']\s*\)\s*\)\s*;/,
    // Standard require
    /require\s*\(\s*["']axios["']\s*\)\s*;/,
];

let injected = false;
for (const pattern of axiosPatterns) {
    const match = code.match(pattern);
    if (match) {
        code = code.replace(match[0], match[0] + PATCH_CODE);
        console.log(`[patch] Injected proxy interceptor after axios import`);
        injected = true;
        break;
    }
}

if (!injected) {
    console.error('[patch] Could not find axios import — skipping');
    console.error('[patch] File content preview (first 1000 chars):');
    console.error(code.substring(0, 1000));
    process.exit(0);
}

fs.writeFileSync(TARGET, code, 'utf8');
console.log('[patch] @polymarket/clob-client patched with proxy support ✅');
