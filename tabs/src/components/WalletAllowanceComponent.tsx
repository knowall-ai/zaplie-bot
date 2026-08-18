import React, { useEffect, useState, useContext } from 'react';
import { useMsal } from '@azure/msal-react';
import './WalletAllowanceComponent.css';
import {
  getUsers,
  getUserWallets,
  getWalletTransactionsSince,
} from '../services/lnbitsServiceLocal';
import { RewardNameContext } from './RewardNameContext';
import SendZapsPopup from './SendZapsPopup';

const SECONDS_PER_DAY = 86_400;
const TRANSACTION_HISTORY_DAYS = 30;

const WalletAllowanceCard: React.FC = () => {
  const [balance, setBalance] = useState<number | null>(null);
  const [spentSats, setSpentSats] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [showSendZapsPopup, setShowSendZapsPopup] = useState(false);
  const { accounts } = useMsal();
  const aadObjectId = accounts[0]?.localAccountId;
  const { rewardName } = useContext(RewardNameContext);

  useEffect(() => {
    let active = true;

    const loadAllowance = async () => {
      setBalance(null);
      setSpentSats(null);
      setError(null);

      if (!aadObjectId) {
        if (active) setError('Sign in to view your Allowance wallet.');
        return;
      }

      try {
        const users = await getUsers({ aadObjectId });
        const matchingUsers = users.filter(
          user => user.aadObjectId === aadObjectId,
        );
        if (matchingUsers.length !== 1) {
          throw new Error(
            "We couldn't match your signed-in account to Zaplie.",
          );
        }

        const currentUser = matchingUsers[0];
        const wallets = await getUserWallets(currentUser.id);
        const allowanceWallets = wallets.filter(
          wallet => wallet.name.trim().toLowerCase() === 'allowance',
        );
        if (allowanceWallets.length !== 1) {
          throw new Error('Your Allowance wallet is unavailable.');
        }

        const allowanceWallet = allowanceWallets[0];
        if (!Number.isFinite(allowanceWallet.balance_msat)) {
          throw new Error('Your Allowance balance is unavailable.');
        }

        const historyStart =
          Date.now() / 1000 - TRANSACTION_HISTORY_DAYS * SECONDS_PER_DAY;
        const transactions = await getWalletTransactionsSince(
          allowanceWallet.id,
          historyStart,
          null,
        );
        if (
          transactions.some(transaction => !Number.isFinite(transaction.amount))
        ) {
          throw new Error('Your Allowance activity is unavailable.');
        }
        const spent =
          transactions
            .filter(transaction => transaction.amount < 0)
            .reduce(
              (total, transaction) => total + Math.abs(transaction.amount),
              0,
            ) / 1000;

        if (active) {
          setBalance(allowanceWallet.balance_msat / 1000);
          setSpentSats(spent);
          setError(null);
        }
      } catch (caught) {
        if (active) {
          setError(
            caught instanceof Error
              ? caught.message
              : 'Unable to load your Allowance wallet.',
          );
        }
      }
    };

    void loadAllowance();
    return () => {
      active = false;
    };
  }, [aadObjectId, retryToken]);

  const loading = balance === null && !error;

  return (
    <>
      <section className="wallet-container" aria-busy={loading}>
        <div className="wallet-header">
          <h4>Allowance</h4>
          <p>Amount available to send to your teammates:</p>
        </div>

        {error ? (
          <div className="allowance-error" role="alert">
            <p>{error}</p>
            {aadObjectId && (
              <button
                type="button"
                onClick={() => setRetryToken(token => token + 1)}
              >
                Try again
              </button>
            )}
          </div>
        ) : (
          <div className="mainContent">
            <div className="allowance-hero">
              <div className="amountDisplayContainer">
                <div className="amountDisplay">
                  {balance === null ? '—' : balance.toLocaleString()}
                </div>
                <div>{rewardName ?? 'Reward name unavailable'}</div>
              </div>
              <button
                type="button"
                className="sendZapsButton"
                onClick={() => setShowSendZapsPopup(true)}
                disabled={loading || !rewardName}
              >
                Send some zaps
              </button>
            </div>

            <dl className="allowance-metrics">
              <div>
                <dt>Available now</dt>
                <dd>
                  {balance === null ? '—' : balance.toLocaleString()}{' '}
                  {rewardName ?? 'Reward name unavailable'}
                </dd>
              </div>
              <div>
                <dt>Sent in the last 30 days</dt>
                <dd>
                  {spentSats === null ? '—' : spentSats.toLocaleString()}{' '}
                  {rewardName ?? 'Reward name unavailable'}
                </dd>
              </div>
            </dl>
          </div>
        )}
      </section>

      {showSendZapsPopup && (
        <SendZapsPopup onClose={() => setShowSendZapsPopup(false)} />
      )}
    </>
  );
};

export default WalletAllowanceCard;
