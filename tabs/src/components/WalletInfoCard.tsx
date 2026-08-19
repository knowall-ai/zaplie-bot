import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import './WalletInfoCard.css';
import { getUsers, getUserWallets } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import SendPayment from './SendPayment';
import ReceivePayment from './ReceivePayment';
import { RewardNameContext } from './RewardNameContext';

type WalletState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; balance: number; user: User };

const walletNameIsPrivate = (wallet: Wallet) =>
  wallet.name.trim().toLowerCase() === 'private';

const WalletYourWalletInfoCard: React.FC = () => {
  const { accounts } = useMsal();
  const aadObjectId = accounts[0]?.localAccountId;
  const [walletState, setWalletState] = useState<WalletState>({
    status: 'loading',
  });
  const [isReceivePopupOpen, setIsReceivePopupOpen] = useState(false);
  const [isSendPopupOpen, setIsSendPopupOpen] = useState(false);
  const requestIdRef = useRef(0);
  const {
    rewardName,
    isLoading: isRewardNameLoading = false,
    error: rewardNameError = null,
  } = useContext(RewardNameContext);

  const loadWallet = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setWalletState({ status: 'loading' });
    setIsReceivePopupOpen(false);
    setIsSendPopupOpen(false);

    if (!aadObjectId) {
      setWalletState({
        status: 'error',
        message: 'Sign in to load your wallet.',
      });
      return;
    }

    try {
      const users = await getUsers({ aadObjectId });
      const matchingUsers = users.filter(
        user => user.aadObjectId === aadObjectId,
      );

      if (requestId !== requestIdRef.current) return;
      if (matchingUsers.length !== 1) {
        setWalletState({
          status: 'error',
          message: "We couldn't match your signed-in account to a wallet.",
        });
        return;
      }

      const user = matchingUsers[0];
      const wallets = await getUserWallets(user.id);
      if (requestId !== requestIdRef.current) return;

      const privateWallets = wallets.filter(walletNameIsPrivate);
      if (privateWallets.length !== 1) {
        setWalletState({
          status: 'error',
          message: "We couldn't find your Private wallet.",
        });
        return;
      }

      const privateWallet = privateWallets[0];
      if (privateWallet.user !== user.id) {
        setWalletState({
          status: 'error',
          message: "We couldn't confirm your Private wallet belongs to you.",
        });
        return;
      }

      if (!Number.isFinite(privateWallet.balance_msat)) {
        setWalletState({
          status: 'error',
          message: "We couldn't read your Private wallet balance.",
        });
        return;
      }

      setWalletState({
        status: 'ready',
        balance: privateWallet.balance_msat / 1000,
        user: { ...user, privateWallet },
      });
    } catch {
      if (requestId === requestIdRef.current) {
        setWalletState({
          status: 'error',
          message: "We couldn't load your wallet. Try again.",
        });
      }
    }
  }, [aadObjectId]);

  useEffect(() => {
    void loadWallet();

    return () => {
      requestIdRef.current += 1;
    };
  }, [loadWallet]);

  const walletReady = walletState.status === 'ready';
  const currentUser = walletReady ? walletState.user : null;

  return (
    <div className="wallet-info">
      <h4>Your wallet</h4>
      <p>Amount received from other users:</p>

      <div
        className="horizontal-container"
        aria-busy={walletState.status === 'loading'}
      >
        {walletState.status === 'loading' ? (
          <p className="wallet-loading" role="status">
            Loading wallet...
          </p>
        ) : walletState.status === 'error' ? (
          <div className="wallet-error-state">
            <p role="alert">{walletState.message}</p>
            <button
              type="button"
              className="wallet-retry-btn"
              onClick={loadWallet}
            >
              Try again
            </button>
          </div>
        ) : (
          <>
            <div className="item">
              <h1>{walletState.balance.toLocaleString()}</h1>
            </div>
            <div className="item">
              {rewardName ??
                (isRewardNameLoading
                  ? 'Loading reward name...'
                  : rewardNameError
                    ? 'Reward name unavailable'
                    : '')}
            </div>
          </>
        )}
      </div>

      <div className="wallet-buttons">
        <button
          type="button"
          onClick={() => setIsReceivePopupOpen(true)}
          className="receive-btn"
          disabled={!walletReady}
        >
          Receive
        </button>
        <button
          type="button"
          onClick={() => setIsSendPopupOpen(true)}
          className="send-btn"
          disabled={!walletReady}
        >
          Send
        </button>

        {isReceivePopupOpen && currentUser ? (
          <div className="overlay" onClick={() => setIsReceivePopupOpen(false)}>
            <div className="popup" onClick={event => event.stopPropagation()}>
              <ReceivePayment
                onClose={() => setIsReceivePopupOpen(false)}
                currentUserLNbitDetails={currentUser}
              />
            </div>
          </div>
        ) : null}

        {isSendPopupOpen && currentUser ? (
          <div className="overlay" onClick={() => setIsSendPopupOpen(false)}>
            <div className="popup" onClick={event => event.stopPropagation()}>
              <SendPayment
                onClose={() => setIsSendPopupOpen(false)}
                currentUserLNbitDetails={currentUser}
              />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

export default WalletYourWalletInfoCard;
