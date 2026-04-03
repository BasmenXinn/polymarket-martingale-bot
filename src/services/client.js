import { ClobClient } from '@polymarket/clob-client';
import { ethers, Wallet } from 'ethers';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { setupAxiosProxy, testProxy } from '../utils/proxy.js';

let clobClient = null;
let signer = null;
let _provider = null; // singleton — reused across all onchain calls

/**
 * Initialize the Polymarket CLOB client
 * Auto-derives API credentials if not provided in .env
 */
export async function initClient() {
    // ── Set up proxy (if configured) BEFORE any Polymarket API calls ──
    await setupAxiosProxy();

    // Test proxy connectivity
    const proxyOk = await testProxy();
    if (!proxyOk) {
        logger.error('Proxy test failed — cannot reach Polymarket. Exiting.');
        process.exit(1);
    }

    logger.info('Initializing Polymarket CLOB client...');

    signer = new Wallet(config.privateKey);
    logger.info(`EOA (signer)  : ${signer.address}`);
    logger.info(`Proxy wallet  : ${config.proxyWallet}`);

    // Step 1: Create temp client to derive API credentials
    let apiCreds;
    if (config.clobApiKey && config.clobApiSecret && config.clobApiPassphrase) {
        apiCreds = {
            key: config.clobApiKey,
            secret: config.clobApiSecret,
            passphrase: config.clobApiPassphrase,
        };
        logger.info('Using API credentials from .env');
    } else {
        const tempClient = new ClobClient(config.clobHost, config.chainId, signer);
        apiCreds = await tempClient.createOrDeriveApiKey();
        logger.info('API credentials derived successfully');
    }

    // Step 2: Initialize full trading client
    // proxyWallet = funder address (where USDC.e is held)
    clobClient = new ClobClient(
        config.clobHost,
        config.chainId,
        signer,
        apiCreds,
        2, // Signature type: 0 = EOA (EOA signs on behalf of proxy wallet)
        config.proxyWallet, // Funder = proxy wallet (deposit USDC.e here)
    );

    logger.success('CLOB client initialized');
    return clobClient;
}

/**
 * Get the initialized CLOB client
 */
export function getClient() {
    if (!clobClient) {
        throw new Error('CLOB client not initialized. Call initClient() first.');
    }
    return clobClient;
}

/**
 * Get the signer wallet
 */
export function getSigner() {
    if (!signer) {
        throw new Error('Signer not initialized. Call initClient() first.');
    }
    return signer;
}

/**
 * Get (or create) the singleton Polygon provider.
 * A single JsonRpcProvider instance is reused across all onchain calls
 * to avoid reconnection overhead on every balance check.
 */
export function getPolygonProvider() {
    if (!_provider) {
        _provider = new ethers.providers.JsonRpcProvider(config.polygonRpcUrl);
    }
    return _provider;
}

/**
 * Get USDC balance via CLOB API collateral allowance.
 * balance field is in micro USDC (6 decimals).
 */
export async function getUsdcBalance() {
    const client = getClient();
    const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    return parseFloat(result.balance) / 1e6;
}
