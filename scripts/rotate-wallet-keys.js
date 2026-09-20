#!/usr/bin/env node

/**
 * Zaplie - LNbits Wallet Key Rotation Script (Issue #375)
 *
 * Rotates adminkey and inkey for user wallets (Allowance and Private)
 * across an LNbits instance following exposure in payment extra metadata.
 *
 * LNbits 1.5.6 PUT /api/v1/wallet/reset/{wallet_id} resets keys for a wallet.
 * The endpoint authenticates the wallet owner. When "user-id-only" is included
 * in AUTH_ALLOWED_METHODS on LNbits, the endpoint authenticates via ?usr={user_id}.
 * The superuser bearer token must not be sent to this endpoint, as LNbits would
 * authenticate the caller as the superuser, failing the wallet-owner check for
 * non-superuser wallets.
 */

const dotenvFlow = require('dotenv-flow');

// Load environment configuration (.env, .env.local, etc.)
dotenvFlow.config({ path: './env' });

/**
 * Parses command-line arguments.
 */
function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dryRun: false,
    allWallets: false,
    walletNames: ['Allowance', 'Private'],
    userFilter: null,
    walletFilter: null,
    nodeUrl: null,
    username: null,
    password: null,
    yes: false,
    help: false,
  };

  const takesValue = new Set([
    '--filter',
    '--wallet-name',
    '--user',
    '-u',
    '--wallet',
    '-w',
    '--url',
    '--username',
  ]);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run' || arg === '-n') {
      options.dryRun = true;
    } else if (arg === '--all-wallets') {
      options.allWallets = true;
    } else if (arg === '--yes' || arg === '-y') {
      options.yes = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--password') {
      throw new Error(
        'Passing --password via command-line arguments is disabled for security. Set the LNBITS_PASSWORD environment variable instead.',
      );
    } else if (takesValue.has(arg)) {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('-')) {
        throw new Error(`Missing value for option ${arg}`);
      }
      const val = argv[++i];
      if (arg === '--filter' || arg === '--wallet-name') {
        options.walletNames = val.split(',').map(s => s.trim()).filter(Boolean);
      } else if (arg === '--user' || arg === '-u') {
        options.userFilter = val;
      } else if (arg === '--wallet' || arg === '-w') {
        options.walletFilter = val;
      } else if (arg === '--url') {
        options.nodeUrl = val;
      } else if (arg === '--username') {
        options.username = val;
      }
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
Zaplie - LNbits Wallet Key Rotation Tool (Issue #375)

Usage:
  node scripts/rotate-wallet-keys.js [options]
  npm run rotate-keys -- [options]

Options:
  --dry-run, -n          Preview wallets to be reset without executing changes
  --yes, -y              Execute live key rotation without interactive confirmation prompt
  --all-wallets          Rotate all user wallets (default: only Allowance and Private)
  --filter <names>       Comma-separated wallet names to rotate (default: Allowance,Private)
  --user, -u <id>        Rotate wallets for a specific LNbits user ID or AAD object ID
  --wallet, -w <id>      Rotate keys for a specific wallet ID only
  --url <url>            LNbits node URL (default: process.env.LNBITS_NODE_URL)
  --username <user>      LNbits admin username (default: process.env.LNBITS_USERNAME)
  --help, -h             Show this help message

Environment Variables:
  LNBITS_NODE_URL        LNbits instance URL (must use HTTPS unless localhost)
  LNBITS_USERNAME        LNbits admin username
  LNBITS_PASSWORD        LNbits admin password (required; cannot be passed via CLI)
  LNBITS_TIMEOUT_MS      Request timeout in milliseconds (default: 15000)

Prerequisites:
  LNbits 1.5.6 PUT /api/v1/wallet/reset/{wallet_id} requires wallet owner authentication.
  Before running this script to rotate keys across users, temporarily enable user-id-only
  authentication on the LNbits server:
    1. Include "user-id-only" in AUTH_ALLOWED_METHODS in LNbits .env or via LNbits Admin UI.
    2. Restart LNbits if modified via .env.
    3. Run this rotation script.
    4. Remove "user-id-only" from AUTH_ALLOWED_METHODS and restart LNbits.
`);
}

/**
 * Resolves node URL, username, and password from options or environment.
 */
function resolveConfig(options = {}) {
  const rawUrl = (
    options.nodeUrl ||
    process.env.LNBITS_NODE_URL ||
    ''
  ).replace(/\/+$/, '');

  const username = options.username || process.env.LNBITS_USERNAME || '';
  const password = options.password || process.env.LNBITS_PASSWORD || '';
  const timeoutMs = options.timeoutMs || Number(process.env.LNBITS_TIMEOUT_MS) || 15000;

  if (!rawUrl) {
    throw new Error(
      'LNbits URL is not configured. Set LNBITS_NODE_URL or pass --url <url>.',
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch (err) {
    throw new Error(`Invalid LNbits URL "${rawUrl}": ${err.message}`);
  }

  const isLocalhost =
    parsedUrl.hostname === 'localhost' ||
    parsedUrl.hostname === '127.0.0.1' ||
    parsedUrl.hostname === '[::1]' ||
    parsedUrl.hostname === '::1';

  if (parsedUrl.protocol !== 'https:' && (!isLocalhost || parsedUrl.protocol !== 'http:')) {
    throw new Error(
      `Insecure protocol for LNbits URL "${rawUrl}": node URL must use HTTPS (HTTP is only allowed for localhost).`,
    );
  }

  const nodeUrl = rawUrl;

  if (!username || !password) {
    throw new Error(
      'LNbits admin credentials missing. Set LNBITS_USERNAME and LNBITS_PASSWORD.',
    );
  }

  return { nodeUrl, username, password, timeoutMs };
}

/**
 * Requests confirmation interactively from TTY.
 */
async function promptConfirmation(message) {
  const readline = require('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await rl.question(message);
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'yes' || trimmed === 'y';
  } finally {
    rl.close();
  }
}

/**
 * Obtains superuser access token.
 */
async function getAccessToken({ nodeUrl, username, password, timeoutMs = 15000, fetchFn = fetch }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(`${nodeUrl}/api/v1/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ username, password }),
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to authenticate with LNbits (HTTP ${response.status}): ${response.statusText}`,
    );
  }

  const data = await response.json();
  if (!data || !data.access_token) {
    throw new Error('Access token missing in LNbits auth response');
  }

  return data.access_token;
}

/**
 * Fetches all LNbits users via Users API.
 */
async function getUsers({ nodeUrl, accessToken, timeoutMs = 15000, fetchFn = fetch }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(`${nodeUrl}/users/api/v1/user`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    signal,
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch users from LNbits (HTTP ${response.status}): ${response.statusText}`,
    );
  }

  const body = await response.json();
  const rawUsers = Array.isArray(body) ? body : body.data || [];
  return rawUsers;
}

/**
 * Fetches all wallets for a specific LNbits user.
 */
async function getUserWallets({ nodeUrl, accessToken, userId, timeoutMs = 15000, fetchFn = fetch }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(
    `${nodeUrl}/users/api/v1/user/${encodeURIComponent(userId)}/wallet`,
    {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      signal,
    },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch wallets for user ${userId} (HTTP ${response.status}): ${response.statusText}`,
    );
  }

  const body = await response.json();
  const wallets = Array.isArray(body) ? body : body.data || [];
  return wallets;
}

/**
 * Filters wallets according to rotation criteria.
 */
function filterWallets(wallets, options = {}) {
  const {
    allWallets = false,
    walletNames = ['Allowance', 'Private'],
    walletFilter = null,
  } = options;

  return wallets.filter(wallet => {
    if (wallet.deleted === true) {
      return false;
    }
    if (walletFilter) {
      return wallet.id === walletFilter;
    }
    if (allWallets) {
      return true;
    }
    return walletNames.includes(wallet.name);
  });
}

/**
 * Resets keys for a single wallet using PUT /api/v1/wallet/reset/{wallet_id}?usr={user_id}.
 * Omit bearer access token so LNbits authenticates via usr query param.
 */
async function resetWalletKey({
  nodeUrl,
  walletId,
  userId,
  oldKeys = {},
  timeoutMs = 15000,
  fetchFn = fetch,
}) {
  const url = `${nodeUrl}/api/v1/wallet/reset/${encodeURIComponent(walletId)}?usr=${encodeURIComponent(userId)}`;

  const headers = {
    'Content-Type': 'application/json',
    accept: 'application/json',
  };

  const signal = AbortSignal.timeout(timeoutMs);
  const response = await fetchFn(url, {
    method: 'PUT',
    headers,
    signal,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `Authentication error (HTTP ${response.status}) resetting wallet ${walletId}. ` +
        `Ensure user-id-only authentication is temporarily enabled by including "user-id-only" in AUTH_ALLOWED_METHODS on LNbits so ?usr=${userId} is accepted.`,
    );
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `Failed to reset wallet ${walletId} (HTTP ${response.status}): ${errorText || response.statusText}`,
    );
  }

  const updatedWallet = await response.json();
  if (!updatedWallet || !updatedWallet.adminkey || !updatedWallet.inkey) {
    throw new Error(`Reset endpoint for wallet ${walletId} did not return valid new keys.`);
  }

  const adminChanged = !oldKeys.adminkey || oldKeys.adminkey !== updatedWallet.adminkey;
  const invoiceChanged = !oldKeys.inkey || oldKeys.inkey !== updatedWallet.inkey;

  return {
    wallet: updatedWallet,
    adminChanged,
    invoiceChanged,
  };
}

/**
 * Main orchestration function.
 */
async function rotateWalletKeys(cliOptions = {}, deps = {}) {
  const options = {
    ...parseArgs([]),
    ...cliOptions,
  };

  const fetchFn = deps.fetchFn || fetch;
  const logger = deps.logger || console;

  const { nodeUrl, username, password, timeoutMs } = resolveConfig(options);

  logger.log(`Connecting to LNbits instance at: ${nodeUrl}`);
  const accessToken = await getAccessToken({ nodeUrl, username, password, timeoutMs, fetchFn });
  logger.log('Successfully authenticated as superuser.');

  logger.log('Retrieving LNbits users...');
  const allUsers = await getUsers({ nodeUrl, accessToken, timeoutMs, fetchFn });
  logger.log(`Found ${allUsers.length} total user(s) in LNbits.`);

  // Filter users if --user flag provided (matches LNbits id or external_id / AAD object ID)
  let targetUsers = allUsers;
  if (options.userFilter) {
    targetUsers = allUsers.filter(
      u => u.id === options.userFilter || u.external_id === options.userFilter,
    );
    logger.log(
      `Filtered to ${targetUsers.length} user(s) matching filter "${options.userFilter}".`,
    );
  }

  const summary = {
    totalUsers: allUsers.length,
    scannedUsers: targetUsers.length,
    totalWalletsScanned: 0,
    targetWalletsFound: 0,
    rotatedWallets: 0,
    rotatedByType: {},
    skippedWallets: 0,
    errors: [],
    results: [],
  };

  if (options.dryRun) {
    logger.log('\n--- [DRY RUN MODE ENABLED: No keys will be modified] ---');
  }

  let confirmed = options.yes || false;

  for (const user of targetUsers) {
    const userLabel =
      user.extra?.display_name || user.username || user.email || user.id;

    let wallets = [];
    try {
      wallets = await getUserWallets({
        nodeUrl,
        accessToken,
        userId: user.id,
        timeoutMs,
        fetchFn,
      });
    } catch (err) {
      const msg = `Failed to fetch wallets for user ${user.id} (${userLabel}): ${err.message}`;
      logger.error(msg);
      summary.errors.push({ userId: user.id, error: msg });
      continue;
    }

    summary.totalWalletsScanned += wallets.length;
    const targeted = filterWallets(wallets, options);
    const skipped = wallets.length - targeted.length;
    summary.skippedWallets += skipped;

    for (const wallet of targeted) {
      summary.targetWalletsFound++;
      const walletType = wallet.name || 'Unknown';

      if (options.dryRun) {
        logger.log(
          `[DRY RUN] Would reset keys for wallet "${wallet.name}" (walletId: ${wallet.id}) of user "${userLabel}" (userId: ${user.id})`,
        );
        summary.results.push({
          userId: user.id,
          walletId: wallet.id,
          walletName: wallet.name,
          dryRun: true,
          status: 'simulated',
        });
        continue;
      }

      if (!confirmed) {
        if (deps.confirmFn) {
          const ok = await deps.confirmFn();
          if (!ok) {
            throw new Error('Key rotation cancelled by user.');
          }
          confirmed = true;
        } else if (!process.stdin.isTTY) {
          throw new Error(
            'Interactive confirmation required to rotate wallet keys live. Pass --yes to execute non-interactively.',
          );
        } else {
          const ok = await promptConfirmation(
            'Are you sure you want to proceed with live key rotation? This will invalidate existing wallet keys. (yes/no): ',
          );
          if (!ok) {
            throw new Error('Key rotation cancelled by user.');
          }
          confirmed = true;
        }
      }

      logger.log(
        `Resetting keys for wallet "${wallet.name}" (walletId: ${wallet.id}) of user "${userLabel}"...`,
      );

      try {
        const resetRes = await resetWalletKey({
          nodeUrl,
          walletId: wallet.id,
          userId: user.id,
          oldKeys: {
            adminkey: wallet.adminkey,
            inkey: wallet.inkey,
          },
          timeoutMs,
          fetchFn,
        });

        summary.rotatedWallets++;
        summary.rotatedByType[walletType] =
          (summary.rotatedByType[walletType] || 0) + 1;

        logger.log(
          `  -> SUCCESS: Keys regenerated (adminkey changed: ${resetRes.adminChanged}, inkey changed: ${resetRes.invoiceChanged})`,
        );

        summary.results.push({
          userId: user.id,
          walletId: wallet.id,
          walletName: wallet.name,
          status: 'success',
          adminChanged: resetRes.adminChanged,
          invoiceChanged: resetRes.invoiceChanged,
        });
      } catch (err) {
        const msg = `Error resetting wallet ${wallet.id} (${wallet.name}) for user ${user.id}: ${err.message}`;
        logger.error(`  -> FAILURE: ${msg}`);
        summary.errors.push({
          userId: user.id,
          walletId: wallet.id,
          walletName: wallet.name,
          error: err.message,
        });
      }
    }
  }

  // Print Summary
  logger.log('\n================ ROTATION SUMMARY ================');
  logger.log(`Total LNbits Users Scanned: ${summary.scannedUsers}`);
  logger.log(`Total Wallets Scanned:     ${summary.totalWalletsScanned}`);
  logger.log(`Target Wallets Matched:    ${summary.targetWalletsFound}`);
  if (options.dryRun) {
    logger.log(`Wallets Planned to Rotate: ${summary.targetWalletsFound}`);
    logger.log('Dry run complete. No keys were altered.');
  } else {
    logger.log(`Wallets Successfully Rotated: ${summary.rotatedWallets}`);
    for (const [type, count] of Object.entries(summary.rotatedByType)) {
      logger.log(`  - ${type}: ${count}`);
    }
    logger.log(`Wallets Skipped:           ${summary.skippedWallets}`);
    logger.log(`Failed / Errors:           ${summary.errors.length}`);
  }
  logger.log('===================================================\n');

  return summary;
}

/**
 * Main entry point when invoked via CLI.
 */
async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`\nError: ${err.message}\nRun with --help for usage information.`);
    process.exit(1);
  }

  if (options.help) {
    printHelp();
    process.exit(0);
  }

  try {
    const summary = await rotateWalletKeys(options);
    if (summary.errors.length > 0) {
      console.error(
        `Completed with ${summary.errors.length} error(s). Please inspect logs above.`,
      );
      process.exit(1);
    }
    process.exit(0);
  } catch (err) {
    console.error(`\nFATAL: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  parseArgs,
  printHelp,
  resolveConfig,
  promptConfirmation,
  getAccessToken,
  getUsers,
  getUserWallets,
  filterWallets,
  resetWalletKey,
  rotateWalletKeys,
};
