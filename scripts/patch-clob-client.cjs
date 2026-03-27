/**
 * patch-clob-client.cjs
 *
 * Patches @polymarket/clob-client to inject proxy support.
 * Runs automatically via `npm install` (postinstall hook).
 *
 * What it does:
 *   - Adds HttpsProxyAgent import to http-helpers/index.js
 *   - Injects proxy agent into every axios request to polymarket.com
 *   - Reads PROXY_URL from process.env at runtime
 *
 * Uses regex matching so it works regardless of code formatting
 * (minified, prettified, different whitespace, etc.)
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

// ── Step 1: Inject proxy helper code ────────────────────────────────────────

const PROXY_CODE = `
// Proxy support for Polymarket API (auto-patched by scripts/patch-clob-client.cjs)
const https_proxy_agent_1 = require("https-proxy-agent");
const getProxyAgent = () => {
    if (process.env.PROXY_URL) {
        return new https_proxy_agent_1.HttpsProxyAgent(process.env.PROXY_URL);
    }
    return undefined;
};
`;

// Try multiple insertion points — different versions format differently
const insertionPatterns = [
    // Pattern 1: require("browser-or-node") with semicolon
    /require\s*\(\s*["']browser-or-node["']\s*\)\s*;/,
    // Pattern 2: require("axios") line (fallback)
    /require\s*\(\s*["']axios["']\s*\)\s*;/,
    // Pattern 3: any require line near the top (last resort)
    /const\s+\w+\s*=\s*require\s*\(\s*["']axios["']\s*\)/,
];

let inserted = false;
for (const pattern of insertionPatterns) {
    const match = code.match(pattern);
    if (match) {
        code = code.replace(match[0], match[0] + PROXY_CODE);
        console.log(`[patch] Injected proxy helper after: ${match[0].substring(0, 50)}...`);
        inserted = true;
        break;
    }
}

if (!inserted) {
    console.error('[patch] Could not find insertion point for proxy code — skipping');
    process.exit(0);
}

// ── Step 2: Patch the request config to inject proxy agent ──────────────────

// Match: const config = { method, url: endpoint, headers, data, params }
// with any whitespace variation (spaces, newlines, tabs)
const configRegex = /const\s+config\s*=\s*\{\s*method\s*,\s*url\s*:\s*endpoint\s*,\s*headers\s*,\s*data\s*,\s*params\s*\}\s*;/;

const configMatch = code.match(configRegex);

if (configMatch) {
    const PROXY_INJECT = `${configMatch[0]}
    // Add proxy agent for Polymarket API
    if (endpoint && endpoint.includes('polymarket.com')) {
        const agent = getProxyAgent();
        if (agent) {
            config.httpsAgent = agent;
            config.proxy = false;
        }
    }`;
    code = code.replace(configMatch[0], PROXY_INJECT);
    console.log('[patch] Injected proxy agent into request config');
} else {
    // Fallback: try to find any config object creation with method/endpoint
    // and inject proxy after it
    const fallbackRegex = /(?:const|let|var)\s+config\s*=\s*\{[^}]*method[^}]*endpoint[^}]*\}\s*;/;
    const fallbackMatch = code.match(fallbackRegex);

    if (fallbackMatch) {
        const PROXY_INJECT = `${fallbackMatch[0]}
    // Add proxy agent for Polymarket API
    if (endpoint && endpoint.includes('polymarket.com')) {
        const agent = getProxyAgent();
        if (agent) {
            config.httpsAgent = agent;
            config.proxy = false;
        }
    }`;
        code = code.replace(fallbackMatch[0], PROXY_INJECT);
        console.log('[patch] Injected proxy agent into request config (fallback match)');
    } else {
        // Last resort: find the axios request/call and inject before it
        const axiosCallRegex = /axios_1\.default\s*\(\s*config\s*\)/;
        const axiosMatch = code.match(axiosCallRegex);

        if (axiosMatch) {
            const PROXY_INJECT = `// Add proxy agent for Polymarket API
    if (config.url && config.url.includes('polymarket.com')) {
        const agent = getProxyAgent();
        if (agent) {
            config.httpsAgent = agent;
            config.proxy = false;
        }
    }
    ${axiosMatch[0]}`;
            code = code.replace(axiosMatch[0], PROXY_INJECT);
            console.log('[patch] Injected proxy agent before axios call (last resort)');
        } else {
            console.error('[patch] Could not find request config or axios call — skipping');
            console.error('[patch] File content preview (first 2000 chars):');
            console.error(code.substring(0, 2000));
            process.exit(0);
        }
    }
}

fs.writeFileSync(TARGET, code, 'utf8');
console.log('[patch] @polymarket/clob-client patched with proxy support ✅');
