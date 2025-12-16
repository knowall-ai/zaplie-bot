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

// Extended User type with wallet information for this component
type UserWithWallet = User & { privateWallet: Wallet | null };

const PRESET_AMOUNTS = [5000, 10000, 25000];

const SendZapsPopup: React.FC<SendZapsPopupProps> = ({ onClose }) => {
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [memo, setMemo] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [users, setUsers] = useState<UserWithWallet[]>([]);
  const [currentUserWallets, setCurrentUserWallets] = useState<{ allowance: Wallet | null; balance: number }>({
    allowance: null,
    balance: 0,
  });
  const [sendAnonymously, setSendAnonymously] = useState(false);
  const [selectedValue, setSelectedValue] = useState<string>('');
  const [paymentHash, setPaymentHash] = useState<string | null>(null);

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
          const fetchedUsers = await getUsers(adminKey, {});
          if (fetchedUsers && fetchedUsers.length > 0) {
            allUsers = fetchedUsers;
            setCache('allUsers', fetchedUsers);
          } else {
            setIsLoadingUsers(false);
            return;
          }
        }

        // Fetch current user's wallet
        const currentUserData = allUsers.find(u => u.aadObjectId === account.localAccountId);

        if (currentUserData) {
          // Always fetch fresh wallet data to get accurate balance
          const wallets = await getUserWallets(adminKey, currentUserData.id);
          const allowanceWallet = wallets?.find(w => w.name.toLowerCase().includes('allowance'));
          const currentBalance = allowanceWallet ? allowanceWallet.balance_msat / 1000 : 0;

          setCurrentUserWallets({
            allowance: allowanceWallet || null,
            balance: currentBalance,
          });
        }

        // Filter out current user - wallet fetching happens on user selection
        const otherUsers = allUsers.filter(u => u.aadObjectId !== account.localAccountId);

        // Initialize users without wallet data - will fetch on selection
        const usersWithoutWallets: UserWithWallet[] = otherUsers.map(user => ({
          ...user,
          privateWallet: null,
        }));

        setUsers(usersWithoutWallets);
      } catch (err) {
        setError('Failed to load users');
      } finally {
        setIsLoadingUsers(false);
      }
    };

    loadUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts]); // cache and setCache are from context and are stable, intentionally excluded

  // Fetch wallet for selected user on demand
  const handleUserSelect = async (userId: string) => {
    setSelectedUser(userId);

    if (!userId) return;

    const user = users.find(u => u.id === userId);
    if (!user || user.privateWallet) return; // Already has wallet or not found

    try {
      const wallets = await getUserWallets(adminKey, userId);
      // Prioritize "private" wallet, then any non-allowance wallet
      let targetWallet = wallets?.find(w => w.name.toLowerCase().includes('private'));
      if (!targetWallet) {
        targetWallet = wallets?.find(w => !w.name.toLowerCase().includes('allowance'));
      }
      if (!targetWallet && wallets && wallets.length > 0) {
        targetWallet = wallets[0];
      }

      // Update user with wallet data
      setUsers(prev => prev.map(u =>
        u.id === userId ? { ...u, privateWallet: targetWallet || null } : u
      ));
    } catch {
      // Silently fail - error will show when trying to send
    }
  };

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
      // Build the memo with value and anonymous prefix if needed
      let paymentMemo = memo || 'Zap payment';
      if (selectedValue) {
        paymentMemo = `[${selectedValue.charAt(0).toUpperCase() + selectedValue.slice(1)}] ${paymentMemo}`;
      }
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
        setPaymentHash(result.payment_hash);
        setSuccess(true);
        // Optimistic update for immediate UI feedback
        // Fresh balance will be fetched from API when popup reopens
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
                    onChange={(e) => handleUserSelect(e.target.value)}
                    className={styles.select}
                    disabled={isLoadingUsers}
                  >
                    <option value="">
                      {isLoadingUsers ? 'Loading users...' : 'Send zaps to'}
                    </option>
                    {!isLoadingUsers && users
                      .filter((user) => {
                        // Check if displayName exists and is not a GUID (32 hex chars)
                        const isGuid = /^[a-f0-9]{32}$/i.test(user.displayName || '');
                        const hasValidName = user.displayName && !isGuid;
                        const hasEmail = user.email && user.email.includes('@');
                        return hasValidName || hasEmail;
                      })
                      .map((user) => {
                        // Check if displayName looks like a GUID
                        const isGuid = /^[a-f0-9]{32}$/i.test(user.displayName || '');
                        const displayText = (!user.displayName || isGuid)
                          ? user.email
                          : user.displayName;
                        return (
                          <option key={user.id} value={user.id}>
                            {displayText || 'Unknown'}
                          </option>
                        );
                      })}
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
            {paymentHash && (
              <div className={styles.transactionId}>
                <span className={styles.transactionLabel}>Transaction ID:</span>
                <span className={styles.transactionHash}>{paymentHash.substring(0, 16)}...</span>
              </div>
            )}
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
