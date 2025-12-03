import React, { useState, useEffect, useContext } from 'react';
import styles from './SendZapsPopup.module.css';
import { RewardNameContext } from './RewardNameContext';
import { useCache } from '../utils/CacheContext';
import { getUserWallets, createInvoice, payInvoice, getUsers } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import loaderGif from '../images/Loader.gif';
import checkmarkIcon from '../images/CheckmarkCircleGreen.svg';
import dismissIcon from '../images/DismissCircleRed.svg';

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

interface SendZapsPopupProps {
  onClose: () => void;
}

const PRESET_AMOUNTS = [5000, 10000, 25000];

const SendZapsPopup: React.FC<SendZapsPopupProps> = ({ onClose }) => {
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [memo, setMemo] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [users, setUsers] = useState<User[]>([]);
  const [currentUserWallets, setCurrentUserWallets] = useState<{ allowance: Wallet | null; balance: number }>({
    allowance: null,
    balance: 0,
  });
  const [sendAnonymously, setSendAnonymously] = useState(false);
  const [selectedValue, setSelectedValue] = useState<string>('');

  const { cache, setCache } = useCache();
  const { accounts } = useMsal();
  const rewardNameContext = useContext(RewardNameContext);
  const rewardsName = rewardNameContext?.rewardName ?? 'Sats';

  useEffect(() => {
    const loadUsers = async () => {
      setIsLoadingUsers(true);
      try {
        const account = accounts[0];
        if (!account?.localAccountId) {
          setIsLoadingUsers(false);
          return;
        }

        // Get users from cache or fetch them
        let allUsers = cache['allUsers'] as User[];
        if (!allUsers || allUsers.length === 0) {
          console.log('Fetching users from API...');
          const fetchedUsers = await getUsers(adminKey, {});
          if (fetchedUsers && fetchedUsers.length > 0) {
            allUsers = fetchedUsers;
            setCache('allUsers', fetchedUsers);
          } else {
            console.log('No users found');
            setIsLoadingUsers(false);
            return;
          }
        }

        console.log('All users:', allUsers.length);

        // Fetch current user's wallet
        const currentUserData = allUsers.find(u => u.aadObjectId === account.localAccountId);
        console.log('Current user data:', currentUserData);

        if (currentUserData) {
          const wallets = await getUserWallets(adminKey, currentUserData.id);
          console.log('Current user wallets:', wallets);
          const allowanceWallet = wallets?.find(w => w.name.toLowerCase().includes('allowance'));

          setCurrentUserWallets({
            allowance: allowanceWallet || null,
            balance: allowanceWallet ? allowanceWallet.balance_msat / 1000 : 0,
          });
        }

        // Filter out current user and fetch wallets for others
        const otherUsers = allUsers.filter(u => u.aadObjectId !== account.localAccountId);
        console.log('Other users:', otherUsers.length);

        const usersWithWallets = await Promise.all(
          otherUsers.map(async (user) => {
            try {
              const wallets = await getUserWallets(adminKey, user.id);
              console.log(`User ${user.displayName} wallets:`, wallets?.map(w => w.name));

              // First try to find a "private" wallet, then fall back to any wallet with an inkey
              let targetWallet = wallets?.find(w => w.name.toLowerCase().includes('private'));
              if (!targetWallet && wallets && wallets.length > 0) {
                // Fall back to first available wallet
                targetWallet = wallets[0];
              }

              return {
                ...user,
                privateWallet: targetWallet || null,
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
      } finally {
        setIsLoadingUsers(false);
      }
    };

    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]); // cache and setCache are from context and are stable, intentionally excluded

  if (!rewardNameContext) {
    return null;
  }

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handlePresetAmount = (presetAmount: number) => {
    setAmount(presetAmount.toString());
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
      // Build the memo with anonymous prefix if needed
      let paymentMemo = memo || 'Zap payment';
      if (sendAnonymously) {
        paymentMemo = `[Anonymous] ${paymentMemo}`;
      }

      // Create invoice in recipient's private wallet
      const paymentRequest = await createInvoice(
        recipient.privateWallet.inkey,
        recipient.privateWallet.id,
        zapAmount,
        paymentMemo
      );

      if (!paymentRequest) {
        throw new Error('Failed to create invoice');
      }

      // Pay the invoice from sender's allowance wallet
      const result = await payInvoice(
        currentUserWallets.allowance.adminkey,
        paymentRequest
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

  const selectedUserData = users.find(u => u.id === selectedUser);
  const isSendDisabled = !selectedUser || !amount || parseFloat(amount) <= 0;

  // Get initials for avatar placeholder
  const getInitials = (name?: string) => {
    if (!name) return '?';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name[0]?.toUpperCase() || '?';
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      {!isLoading && !success && !error && (
        <div className={styles.popup}>
          {/* Header Banner with lightning pattern */}
          <div className={styles.headerBanner}>
            <div className={styles.avatarContainer}>
              {selectedUserData ? (
                <div className={styles.avatarPlaceholder}>
                  {getInitials(selectedUserData.displayName)}
                </div>
              ) : (
                <div className={styles.avatarPlaceholder}>
                  <span>⚡</span>
                </div>
              )}
            </div>
          </div>

          {/* Popup Content */}
          <div className={styles.popupContent}>
            <h2 className={styles.title}>Send some zaps</h2>
            <p className={styles.text}>
              Show gratitude, thanks and recognising awesomeness to others in your team
            </p>

            {/* Two Column Layout */}
            <div className={styles.formRow}>
              {/* Left Column - User Selection */}
              <div className={styles.formColumn}>
                <div className={styles.formGroup}>
                  <select
                    value={selectedUser}
                    onChange={(e) => setSelectedUser(e.target.value)}
                    className={styles.select}
                    disabled={isLoadingUsers}
                  >
                    <option value="">
                      {isLoadingUsers ? 'Loading users...' : 'Send zaps to'}
                    </option>
                    {!isLoadingUsers && users.map((user) => (
                      <option key={user.id} value={user.id}>
                        {user.displayName || user.email || 'Unknown'}
                      </option>
                    ))}
                  </select>
                </div>

                {/* User count info */}
                {!isLoadingUsers && users.length > 0 && (
                  <p className={styles.balanceText}>
                    {users.length} team member{users.length !== 1 ? 's' : ''} available
                  </p>
                )}
              </div>

              {/* Right Column - Amount */}
              <div className={styles.formColumn}>
                <div className={styles.formGroup}>
                  <div className={styles.amountInputRow}>
                    <input
                      type="number"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="Specify amount"
                      min="1"
                      className={styles.amountInput}
                    />
                    <span className={styles.currencyLabel}>{rewardsName}</span>
                  </div>
                </div>

                {/* Preset Amount Buttons */}
                <div className={styles.presetAmounts}>
                  {PRESET_AMOUNTS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => handlePresetAmount(preset)}
                      className={
                        amount === preset.toString()
                          ? styles.presetButtonActive
                          : styles.presetButton
                      }
                    >
                      {preset.toLocaleString()}
                    </button>
                  ))}
                </div>

                {/* Value Dropdown */}
                <div className={styles.formGroup}>
                  <select
                    value={selectedValue}
                    onChange={(e) => setSelectedValue(e.target.value)}
                    className={styles.valueSelect}
                  >
                    <option value="">Value</option>
                    <option value="teamwork">Teamwork</option>
                    <option value="innovation">Innovation</option>
                    <option value="excellence">Excellence</option>
                    <option value="integrity">Integrity</option>
                  </select>
                </div>
              </div>
            </div>

            {/* Description */}
            <div className={styles.formGroup}>
              <textarea
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Description"
                className={styles.textarea}
                rows={3}
              />
            </div>

            {/* Balance Info */}
            <p className={styles.balanceText}>
              Available balance: {currentUserWallets.balance.toLocaleString()} {rewardsName}
            </p>

            {/* Action Row */}
            <div className={styles.actionRow}>
              <div className={styles.leftActions}>
                <button onClick={handleClose} className={styles.cancelButton}>
                  Cancel
                </button>
              </div>

              <div className={styles.rightActions}>
                <label className={styles.checkboxLabel}>
                  <input
                    type="checkbox"
                    checked={sendAnonymously}
                    onChange={(e) => setSendAnonymously(e.target.checked)}
                    className={styles.checkbox}
                  />
                  Send anonymously
                </label>

                <button
                  onClick={handleSendZap}
                  className={isSendDisabled ? styles.sendButtonDisabled : styles.sendButton}
                  disabled={isSendDisabled}
                >
                  Send
                </button>
              </div>
            </div>
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
