/**
 * Shared, fail-closed wallet selection for the account-facing portal views.
 *
 * Every consumer used to pick a wallet with `name.includes('private')` and
 * read its balance straight out. That silently tolerated near-matches
 * ("Private archive"), duplicates, wallets belonging to somebody else, and
 * balances the gateway could not read. These helpers make each of those
 * visible instead.
 */

/**
 * Ownership check for a list the gateway already scoped to `userId`
 * (`GET /users/:id/wallets`).
 *
 * A wallet whose `user` names somebody else is refused: that is a real
 * mismatch and must never be attributed to this user. A wallet with no `user`
 * at all is treated as owned, because the only thing it can mean on a
 * server-scoped list is that LNbits omitted the field — rejecting it would
 * lock every tenant out of their own wallet the day LNbits changes its
 * payload. The warning is there so the omission is not silent.
 */
export const isOwnedBy = (wallet: Wallet, userId: string): boolean => {
  if (!wallet.user) {
    console.warn(
      `[wallets] LNbits returned wallet ${wallet.id} with no owner; treating it as owned by ${userId} because the list is already scoped to that user.`,
    );
    return true;
  }
  return wallet.user === userId;
};

/** True when the gateway read a finite balance for this wallet. */
export const isFunded = (wallet: Wallet): wallet is FundedWallet =>
  typeof wallet.balance_msat === 'number' &&
  Number.isFinite(wallet.balance_msat);

export interface WalletMatch {
  /** The chosen wallet, or null when no owned wallet carries this exact name. */
  wallet: Wallet | null;
  /** How many owned wallets carried the name. >1 means the account needs merging. */
  matchCount: number;
  /** True when a wallet with this exact name exists but belongs to another user. */
  foreignMatch: boolean;
}

/**
 * Select the wallet named `name` (exact, case- and space-insensitive) for
 * `userId`.
 *
 * Duplicates do not fail: `src/services/userService.ts` provisions wallets
 * find-or-create with no lock, so two concurrent first turns — or an admin
 * adding a second "Private" by hand — genuinely produce two. Refusing to
 * render then left the user permanently locked out of their own wallet with a
 * "Try again" button that could never help.
 *
 * The tie-break is the lexicographically smallest id. That is a *stable*
 * choice, not a chronological one: LNbits wallet ids are random UUIDs, the
 * wallet model carries no creation timestamp, and LNbits documents no order
 * for the list, so nothing here can identify the older wallet. Sorting only
 * guarantees that every view and every reload picks the same one, instead of
 * the account silently changing wallet depending on response order. The
 * caller surfaces a warning naming the chosen wallet so a wrong pick is
 * visible rather than silent; picking authoritatively would need the chosen
 * wallet id persisted at provisioning time (see the PR discussion).
 */
export const selectWalletByName = (
  wallets: Wallet[],
  userId: string,
  name: string,
): WalletMatch => {
  const named = wallets.filter(
    wallet => wallet.name.trim().toLowerCase() === name,
  );
  const owned = named.filter(wallet => isOwnedBy(wallet, userId));

  if (owned.length === 0) {
    return { wallet: null, matchCount: 0, foreignMatch: named.length > 0 };
  }

  // Stable, not chronological — see the doc comment above.
  const [wallet] = [...owned].sort((a, b) => a.id.localeCompare(b.id));
  return { wallet, matchCount: owned.length, foreignMatch: false };
};

/**
 * Names the wallet on screen, because the pick is only stable, not provably
 * the right one: if it is the wrong wallet, the id is what support needs.
 */
export const duplicateWalletWarning = (wallet: Wallet, count: number): string =>
  `${count} wallets on your account share this name. Showing ${wallet.id} — ask support to merge them.`;
