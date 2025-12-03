import React, { useState, useEffect, useContext } from 'react';
import styles from './SendZapsPopup.module.css';
import { RewardNameContext } from './RewardNameContext';
import { useCache } from '../utils/CacheContext';
import { getUserWallets, createInvoice, payInvoice } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import loaderGif from '../images/Loader.gif';
import checkmarkIcon from '../images/CheckmarkCircleGreen.svg';
import dismissIcon from '../images/DismissCircleRed.svg';

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

interface SendZapsPopupProps {
  onClose: () => void;
}

const SendZapsPopup: React.FC<SendZapsPopupProps> = ({ onClose }) => {
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [memo, setMemo] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [currentUserWallets, setCurrentUserWallets] = useState<{ allowance: Wallet | null; balance: number }>({
    allowance: null,
    balance: 0,
  });
  const [searchTerm, setSearchTerm] = useState<string>('');

  const { cache } = useCache();
  const { accounts } = useMsal();
  const rewardNameContext = useContext(RewardNameContext);

  if (!rewardNameContext) {
    return null;
  }

  const rewardsName = rewardNameContext.rewardName;

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const allUsers = cache['allUsers'] as User[];
        const account = accounts[0];

        if (!allUsers || allUsers.length === 0 || !account?.localAccountId) {
          return;
        }

        // Fetch current user's wallet
        const currentUserData = allUsers.find(u => u.aadObjectId === account.localAccountId);
        if (currentUserData) {
          const wallets = await getUserWallets(adminKey, currentUserData.id);
          const allowanceWallet = wallets?.find(w => w.name.toLowerCase().includes('allowance'));

          setCurrentUserWallets({
            allowance: allowanceWallet || null,
            balance: allowanceWallet ? allowanceWallet.balance_msat / 1000 : 0,
          });
        }

        // Filter out current user and fetch wallets for others
        const otherUsers = allUsers.filter(u => u.aadObjectId !== account.localAccountId);
        const usersWithWallets = await Promise.all(
          otherUsers.map(async (user) => {
            try {
              const wallets = await getUserWallets(adminKey, user.id);
              const privateWallet = wallets?.find(w => w.name.toLowerCase().includes('private'));
              return {
                ...user,
                privateWallet: privateWallet || null,
              };
            } catch (err) {
              console.error(`Error fetching wallets for user ${user.displayName}:`, err);
              return user;
            }
          })
        );

        setUsers(usersWithWallets);
      } catch (err) {
        console.error('Error loading users:', err);
        setError('Failed to load users');
      }
    };

    loadUsers();
  }, [cache, accounts]);

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handleSendZap = async () => {
    // Validation
    if (!selectedUser) {
      setError('Please select a user');
      return;
    }

    if (!amount || parseFloat(amount) <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    const zapAmount = parseFloat(amount);

    // Balance validation
    if (zapAmount > currentUserWallets.balance) {
      setError(`Insufficient balance. You have ${currentUserWallets.balance} ${rewardsName} available.`);
      return;
    }

    if (!currentUserWallets.allowance) {
      setError('Allowance wallet not found');
      return;
    }

    const recipient = users.find(u => u.id === selectedUser);
    if (!recipient || !recipient.privateWallet) {
      setError('Recipient wallet not found');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Create invoice in recipient's private wallet
      const extra = {
        from: currentUserWallets.allowance,
        to: recipient.privateWallet,
        tag: 'zap',
      };

      const paymentRequest = await createInvoice(
        recipient.privateWallet.inkey,
        recipient.privateWallet.id,
        zapAmount,
        memo || 'Zap payment',
        extra
      );

      if (!paymentRequest) {
        throw new Error('Failed to create invoice');
      }

      // Pay the invoice from sender's allowance wallet
      const result = await payInvoice(
        currentUserWallets.allowance.adminkey,
        paymentRequest,
        extra
      );

      if (result && result.payment_hash) {
        setSuccess(true);
        // Update balance
        const updatedBalance = currentUserWallets.balance - zapAmount;
        setCurrentUserWallets(prev => ({ ...prev, balance: updatedBalance }));
      } else {
        throw new Error('Payment failed');
      }
    } catch (err) {
      console.error('Error sending zap:', err);
      setError(err instanceof Error ? err.message : 'Failed to send zap');
    } finally {
      setIsLoading(false);
    }
  };

  const handleClose = () => {
    setSuccess(false);
    setError(null);
    onClose();
  };

  const filteredUsers = users.filter(user =>
    user.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    user.email?.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const isSendDisabled = !selectedUser || !amount || parseFloat(amount) <= 0;

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      {!isLoading && !success && !error && (
        <div className={styles.popup}>
          <p className={styles.title}>Send some zaps</p>
          <p className={styles.text}>
            Show gratitude, thanks, and recognize awesomeness to others in your team
          </p>

          <div className={styles.formGroup}>
            <label className={styles.label}>Select user</label>
            <input
              type="text"
              placeholder="Search users..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className={styles.searchInput}
            />
            <select
              value={selectedUser}
              onChange={(e) => setSelectedUser(e.target.value)}
              className={styles.select}
            >
              <option value="">-- Select a user --</option>
              {filteredUsers.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.displayName || user.email || 'Unknown'}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label}>Amount ({rewardsName})</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Enter amount"
              min="1"
              className={styles.input}
            />
            <p className={styles.balanceText}>
              Available balance: {currentUserWallets.balance.toLocaleString()} {rewardsName}
            </p>
          </div>

          <div className={styles.formGroup}>
            <label className={styles.label}>Message (optional)</label>
            <textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Add a message..."
              className={styles.textarea}
              rows={3}
            />
          </div>

          <div className={styles.actionRow}>
            <button onClick={handleClose} className={styles.cancelButton}>
              Cancel
            </button>
            <button
              onClick={handleSendZap}
              className={isSendDisabled ? styles.sendButtonDisabled : styles.sendButton}
              disabled={isSendDisabled}
            >
              Send from Allowance
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className={styles.loaderOverlay}>
          <img src={loaderGif} alt="Loading..." className={styles.loaderIcon} />
          <p className={styles.loaderText}>Sending zap...</p>
        </div>
      )}

      {!isLoading && success && (
        <div className={styles.overlay} onClick={handleOverlayClick}>
          <div className={styles.successPopup}>
            <div className={styles.popupHeader}>
              <img
                src={checkmarkIcon}
                alt="Success"
                className={styles.statusIcon}
              />
              <div className={styles.popupText}>Zap sent successfully!</div>
            </div>
            <button className={styles.closeButton} onClick={handleClose}>
              Close
            </button>
          </div>
        </div>
      )}

      {!isLoading && error && (
        <div className={styles.overlay} onClick={handleOverlayClick}>
          <div className={styles.errorPopup}>
            <div className={styles.popupHeader}>
              <img
                src={dismissIcon}
                alt="Error"
                className={styles.statusIcon}
              />
              <div className={styles.popupText}>Failed to send zap</div>
            </div>
            <div className={styles.errorMessage}>{error}</div>
            <button className={styles.closeButton} onClick={() => setError(null)}>
              Try Again
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export default SendZapsPopup;
