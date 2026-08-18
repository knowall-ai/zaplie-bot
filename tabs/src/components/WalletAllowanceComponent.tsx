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
  const [showSendZapsPopup, setShowSendZapsPopup] = useState(false);
  const { accounts } = useMsal();
  const rewardNameContext = useContext(RewardNameContext);

  useEffect(() => {
    let active = true;

    const loadAllowance = async () => {
      const aadObjectId = accounts[0]?.localAccountId;
      if (!aadObjectId) {
        if (active) setError('Sign in to view your Allowance wallet.');
        return;
      }

      try {
        const [currentUser] = await getUsers({ aadObjectId });
        if (!currentUser) {
          throw new Error('No Zaplie account is linked to this sign-in.');
        }

        const wallets = await getUserWallets(currentUser.id);
        const allowanceWallet = wallets.find(
          wallet => wallet.name.trim().toLowerCase() === 'allowance',
        );
        if (!allowanceWallet) {
          throw new Error('Your Allowance wallet is unavailable.');
        }

        const historyStart =
          Date.now() / 1000 - TRANSACTION_HISTORY_DAYS * SECONDS_PER_DAY;
        const transactions = await getWalletTransactionsSince(
          allowanceWallet.id,
          historyStart,
          null,
        );
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

    loadAllowance();
    return () => {
      active = false;
    };
  }, [accounts]);

  if (!rewardNameContext) {
    return null;
  }

  const rewardsName = rewardNameContext.rewardName;
  const loading = balance === null && !error;

  return (
    <>
      <section className="wallet-container" aria-busy={loading}>
        <div className="wallet-header">
          <h4>Allowance</h4>
          <p>Amount available to send to your teammates:</p>
        </div>

        {error ? (
          <p className="allowance-error" role="alert">
            {error}
          </p>
        ) : (
          <div className="mainContent">
            <div className="allowance-hero">
              <div className="amountDisplayContainer">
                <div className="amountDisplay">
                  {balance === null ? '—' : balance.toLocaleString()}
                </div>
                <div>{rewardsName}</div>
              </div>
              <button
                type="button"
                className="sendZapsButton"
                onClick={() => setShowSendZapsPopup(true)}
                disabled={loading}
              >
                Send some zaps
              </button>
            </div>

            <dl className="allowance-metrics">
              <div>
                <dt>Available now</dt>
                <dd>
                  {balance === null ? '—' : balance.toLocaleString()}{' '}
                  {rewardsName}
                </dd>
              </div>
              <div>
                <dt>Sent in the last 30 days</dt>
                <dd>
                  {spentSats === null ? '—' : spentSats.toLocaleString()}{' '}
                  {rewardsName}
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
