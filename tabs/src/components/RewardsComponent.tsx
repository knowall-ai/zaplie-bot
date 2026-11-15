import React, {
  FunctionComponent,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { useMsal } from '@azure/msal-react';
import styles from './RewardsComponent.module.css';
import { getNostrRewards } from '../services/wallet/rewards';
import { getUsers } from '../services/wallet/users';
import { getUserWallets } from '../services/wallet/wallets';
import PurchasePopup from './PurchasePopup';
import imagePlaceholder from '../images/imagePlaceholderNew.svg';
import { RewardNameContext } from './RewardNameContext';
import {
  isFunded,
  selectWalletByName,
} from '../services/wallet/walletSelection';

// Read per call rather than once at module load, so a test (and a re-render
// after a config change) sees the current value.
const getStoreId = () => process.env.REACT_APP_LNBITS_STORE_ID?.trim();

const safeProductUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

// Fail closed on the payload too: a reward whose price is not a finite number
// renders as "NaN" in the card and in the request email, a missing description
// throws on `.length`, and a missing `id` collapses the React keys.
//
// One malformed product must not take the whole tab down with it, though, so
// bad items are dropped and counted rather than rejecting the response — a
// catalogue with a typo in it still sells the other rewards.
const isReward = (value: unknown): value is Reward => {
  const reward = value as Reward | null;
  return (
    !!reward &&
    typeof reward === 'object' &&
    typeof reward.id === 'string' &&
    reward.id.trim().length > 0 &&
    typeof reward.name === 'string' &&
    reward.name.trim().length > 0 &&
    typeof reward.shortDescription === 'string' &&
    // A price must be a whole, non-negative number of units. A negative price
    // would make the eligibility check pass against any balance, and a
    // fractional one would reach the request email as "12.5 sats".
    Number.isSafeInteger(reward.price) &&
    reward.price >= 0
  );
};

const RewardsComponent: FunctionComponent = () => {
  const { instance, accounts } = useMsal();
  const { rewardNameLabel } = useContext(RewardNameContext);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [selectedReward, setSelectedReward] = useState<Reward | null>(null);
  const [hasEnoughSats, setHasEnoughSats] = useState(false);
  const [loading, setLoading] = useState(true);
  // Two independent failures with two different retries: the catalogue load
  // retries through loadRewards, an eligibility check retries by clicking the
  // same reward again. Sharing one error made "Try again" reload the
  // catalogue after a wallet failure, which could never fix it.
  const [error, setError] = useState<string | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [droppedCount, setDroppedCount] = useState(0);
  const [checkingReward, setCheckingReward] = useState<string | null>(null);

  const loadRewards = useCallback(async () => {
    const storeId = getStoreId();
    if (!storeId) {
      setError('Rewards are not configured for this environment.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    setRequestError(null);
    setDroppedCount(0);
    try {
      const response = await getNostrRewards(storeId);
      if (!Array.isArray(response)) {
        throw new Error('The rewards service returned an invalid response.');
      }

      const usable = response.filter(isReward);
      const dropped = response.length - usable.length;
      if (dropped > 0) {
        console.warn(
          `[rewards] Dropped ${dropped} of ${response.length} rewards with a missing id, name, description or price.`,
        );
      }
      if (usable.length === 0 && response.length > 0) {
        throw new Error('The rewards service returned an invalid response.');
      }

      setRewards(usable);
      setDroppedCount(dropped);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : 'Rewards are unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRewards();
  }, [loadRewards]);

  const handleRequestClick = async (price: number, reward: Reward) => {
    // One check at a time: a slow earlier click must not resolve after a later
    // one and swap the popup to the wrong reward.
    if (checkingReward) return;
    setRequestError(null);
    setCheckingReward(reward.id);

    try {
      // index.tsx sets the active account; accounts[0] is only the fallback.
      const aadObjectId = (instance.getActiveAccount() ?? accounts[0])
        ?.localAccountId;
      if (!aadObjectId) throw new Error('Sign in to request a reward.');

      const users = await getUsers({ aadObjectId });
      const matchingUsers = users.filter(
        user => user.aadObjectId === aadObjectId,
      );
      if (matchingUsers.length !== 1) {
        throw new Error("We couldn't match your signed-in account to Zaplie.");
      }

      const currentUser = matchingUsers[0];
      const wallets = await getUserWallets(currentUser.id);
      // Same selection rule as WalletInfoCard: never judge eligibility from
      // somebody else's balance, but a duplicate wallet resolves to the oldest
      // rather than blocking the request.
      const match = selectWalletByName(wallets, currentUser.id, 'private');
      if (match.foreignMatch) {
        throw new Error(
          "We couldn't confirm your Private wallet belongs to you.",
        );
      }
      if (!match.wallet) {
        throw new Error('Your Private wallet is unavailable.');
      }

      const privateWallet = match.wallet;
      if (!isFunded(privateWallet)) {
        throw new Error('Your Private wallet balance is unavailable.');
      }

      setHasEnoughSats(privateWallet.balance_msat / 1000 >= price);
      setSelectedReward(reward);
    } catch (caught) {
      setRequestError(
        caught instanceof Error
          ? caught.message
          : 'Unable to check reward eligibility.',
      );
    } finally {
      setCheckingReward(null);
    }
  };

  return (
    <section className={styles.mainContainer} aria-busy={loading}>
      <h1 className={styles.title}>Rewards</h1>
      {error && (
        <div className={styles.error} role="alert">
          <span>{error}</span>
          {getStoreId() && (
            <button type="button" onClick={() => void loadRewards()}>
              Try again
            </button>
          )}
        </div>
      )}
      {requestError && (
        <div className={styles.error} role="alert">
          {/* No retry button: the retry for this is clicking the reward
              again, which reruns exactly the check that failed. */}
          <span>{requestError}</span>
        </div>
      )}
      {droppedCount > 0 && (
        <p className={styles.noPointer} role="status">
          {droppedCount} reward{droppedCount === 1 ? '' : 's'} could not be
          displayed because the rewards service returned incomplete data.
        </p>
      )}
      {loading ? (
        <p className={styles.noPointer}>Loading rewards…</p>
      ) : rewards.length ? (
        <div className={styles.rewardGrid}>
          {rewards.map(reward => {
            const productUrl = reward.link ? safeProductUrl(reward.link) : null;
            return (
              <article key={reward.id} className={styles.card}>
                <img
                  src={reward.image || imagePlaceholder}
                  alt=""
                  className={styles.rewardImage}
                  draggable={false}
                />
                <h2 className={styles.cardTitle}>{reward.name}</h2>
                <p className={styles.cardDescription}>
                  {reward.shortDescription.length > 140
                    ? `${reward.shortDescription.slice(0, 140)}…`
                    : reward.shortDescription}
                </p>
                {productUrl && (
                  <a
                    className={styles.productDetails}
                    href={productUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Product details
                  </a>
                )}
                <div className={styles.priceContainer}>
                  <p className={styles.price}>
                    {new Intl.NumberFormat('en-US').format(reward.price)}
                  </p>
                  <p className={styles.sats}>{rewardNameLabel}</p>
                </div>
                <button
                  type="button"
                  className={styles.buyButton}
                  onClick={() => void handleRequestClick(reward.price, reward)}
                  aria-label={`Request ${reward.name}`}
                  disabled={checkingReward !== null}
                >
                  {checkingReward === reward.id
                    ? 'Checking…'
                    : 'Request reward'}
                </button>
              </article>
            );
          })}
        </div>
      ) : !error ? (
        <p className={styles.noPointer}>No rewards are available.</p>
      ) : null}
      {selectedReward && (
        <PurchasePopup
          onClose={() => setSelectedReward(null)}
          hasEnoughSats={hasEnoughSats}
          reward={selectedReward}
        />
      )}
    </section>
  );
};

export default RewardsComponent;
