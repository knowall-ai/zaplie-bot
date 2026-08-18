import React, { useState, useEffect, useContext, useRef } from 'react';
import styles from './SendZapsPopup.module.css';
import { RewardNameContext } from './RewardNameContext';
import { useCache } from '../utils/CacheContext';
import {
  getUserWallets,
  getUsers,
  invalidateWalletCache,
  sendZap,
} from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import checkmarkIcon from '../images/CheckmarkCircleGreen.svg';
import dismissIcon from '../images/DismissCircleRed.svg';
import {
  pickExactWallet,
  prepareZapRequest,
  ZapRequest,
} from '../utils/paymentState';

interface SendZapsPopupProps {
  onClose: () => void;
  initialUserId?: string;
}

type UserWithWallet = User & { privateWallet: Wallet | null };

const PRESET_AMOUNTS = [20, 5000, 10000, 25000];

const SendZapsPopup: React.FC<SendZapsPopupProps> = ({
  onClose,
  initialUserId,
}) => {
  const [selectedUser, setSelectedUser] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [memo, setMemo] = useState<string>('');
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [users, setUsers] = useState<UserWithWallet[]>([]);
  const [currentUserWallets, setCurrentUserWallets] = useState<{
    allowance: Wallet | null;
    balance: number | null;
  }>({
    allowance: null,
    balance: null,
  });
  const [sendAnonymously, setSendAnonymously] = useState(false);
  const [selectedValue, setSelectedValue] = useState<string>('');
  const [paymentHash, setPaymentHash] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const requestRef = useRef<ZapRequest | null>(null);

  const { cache, setCache } = useCache();
  const cachedUsers = cache['allUsers'];
  const { accounts } = useMsal();
  const { rewardName } = useContext(RewardNameContext);

  useEffect(() => {
    const loadUsers = async () => {
      setIsLoadingUsers(true);
      try {
        const account = accounts[0];
        if (!account?.localAccountId) {
          throw new Error('Sign in to send zaps.');
        }

        let allUsers = Array.isArray(cachedUsers)
          ? (cachedUsers as User[])
          : [];
        if (allUsers.length === 0) {
          const fetchedUsers = await getUsers({});
          if (fetchedUsers.length > 0) {
            allUsers = fetchedUsers;
            setCache('allUsers', fetchedUsers);
          } else {
            throw new Error('No Zaplie users are available.');
          }
        }

        const matchingUsers = allUsers.filter(
          u => u.aadObjectId === account.localAccountId,
        );
        if (matchingUsers.length !== 1) {
          throw new Error(
            "We couldn't match your signed-in account to Zaplie.",
          );
        }

        const currentUserData = matchingUsers[0];
        setCurrentUserId(currentUserData.id);

        const wallets = await getUserWallets(currentUserData.id);
        const allowanceWallet = pickExactWallet(wallets, 'allowance');
        if (!allowanceWallet) {
          throw new Error('Your Allowance wallet is unavailable.');
        }
        if (!Number.isFinite(allowanceWallet.balance_msat)) {
          throw new Error('Your Allowance balance is unavailable.');
        }

        setCurrentUserWallets({
          allowance: allowanceWallet,
          balance: allowanceWallet.balance_msat / 1000,
        });

        const otherUsers = allUsers.filter(
          u => u.aadObjectId !== account.localAccountId,
        );

        const usersWithoutWallets: UserWithWallet[] = otherUsers.map(user => ({
          ...user,
          privateWallet: null,
        }));

        setUsers(usersWithoutWallets);

        if (
          initialUserId &&
          usersWithoutWallets.some(u => u.id === initialUserId)
        ) {
          setSelectedUser(initialUserId);
          const wallets = await getUserWallets(initialUserId);
          const targetWallet = pickExactWallet(wallets, 'private');
          if (!targetWallet) {
            throw new Error('The selected recipient has no Private wallet.');
          }
          setUsers(prev =>
            prev.map(u =>
              u.id === initialUserId
                ? { ...u, privateWallet: targetWallet }
                : u,
            ),
          );
        }
      } catch (caught) {
        setError(
          caught instanceof Error ? caught.message : 'Unable to load users.',
        );
      } finally {
        setIsLoadingUsers(false);
      }
    };

    void loadUsers();
  }, [accounts, cachedUsers, initialUserId, setCache]);

  const handleUserSelect = async (userId: string) => {
    setSelectedUser(userId);
    setError(null);

    if (!userId) return;

    const user = users.find(u => u.id === userId);
    if (!user || user.privateWallet) return;

    try {
      const wallets = await getUserWallets(userId);
      const targetWallet = pickExactWallet(wallets, 'private');
      if (!targetWallet) {
        throw new Error('The selected recipient has no Private wallet.');
      }
      setUsers(prev =>
        prev.map(u =>
          u.id === userId ? { ...u, privateWallet: targetWallet } : u,
        ),
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : 'Unable to load the recipient wallet.',
      );
    }
  };

  const handleOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  const handlePresetAmount = (presetAmount: number) => {
    setAmount(presetAmount.toString());
  };

  const handleSendZap = async () => {
    if (!selectedUser) {
      setError('Please select a user');
      return;
    }

    if (!rewardName) {
      setError('The reward name is unavailable. Try again later.');
      return;
    }

    if (!memo.trim()) {
      setError('Add a description for this zap.');
      return;
    }

    const zapAmount = Number(amount);
    if (!Number.isSafeInteger(zapAmount) || zapAmount <= 0) {
      setError('Please enter a valid amount');
      return;
    }

    if (currentUserWallets.balance === null) {
      setError('Your Allowance balance is unavailable.');
      return;
    }

    if (zapAmount > currentUserWallets.balance) {
      setError(
        `Insufficient balance. You have ${currentUserWallets.balance} ${rewardName} available.`,
      );
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
      let paymentMemo = memo.trim();
      if (selectedValue) {
        paymentMemo = `[${selectedValue.charAt(0).toUpperCase() + selectedValue.slice(1)}] ${paymentMemo}`;
      }
      if (sendAnonymously) {
        paymentMemo = `[Anonymous] ${paymentMemo}`;
      }

      const fingerprint = JSON.stringify([
        recipient.id,
        zapAmount,
        paymentMemo,
      ]);
      requestRef.current = prepareZapRequest(requestRef.current, fingerprint);
      const result = await sendZap(
        recipient.id,
        zapAmount,
        paymentMemo,
        requestRef.current.key,
      );

      requestRef.current = null;
      setPaymentHash(result.payment_hash);
      setSuccess(true);
      if (currentUserId) {
        invalidateWalletCache(currentUserId);
        try {
          const refreshedWallets = await getUserWallets(currentUserId);
          const refreshedAllowance = pickExactWallet(
            refreshedWallets,
            'allowance',
          );
          setCurrentUserWallets({
            allowance: refreshedAllowance ?? null,
            balance: refreshedAllowance
              ? refreshedAllowance.balance_msat / 1000
              : null,
          });
        } catch {
          setCurrentUserWallets(prev => ({ ...prev, balance: null }));
        }
      }
    } catch (err) {
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
  const isSendDisabled =
    !selectedUser ||
    !amount ||
    !memo.trim() ||
    !rewardName ||
    parseFloat(amount) <= 0;

  const getInitials = (name?: string) => {
    if (!name) return '?';
    const parts = name.split(' ');
    if (parts.length >= 2) {
      return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
    }
    return name[0]?.toUpperCase() || '?';
  };

  const getDisplayName = (user?: UserWithWallet) => {
    if (!user) return '';
    const isGuid = /^[a-f0-9]{32}$/i.test(user.displayName || '');
    return (
      (!user.displayName || isGuid ? user.email : user.displayName) || 'Unknown'
    );
  };
  const recipientName = getDisplayName(selectedUserData);
  const numericAmount = Number(amount);
  const amountIsValid =
    Number.isSafeInteger(numericAmount) && numericAmount > 0;

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      {!success && (
        <div
          className={styles.popup}
          role="dialog"
          aria-modal="true"
          aria-labelledby="send-zaps-title"
        >
          <div className={styles.popupContent}>
            <h2 id="send-zaps-title" className={styles.title}>
              Send some zaps
            </h2>
            <p className={styles.subtitle}>
              Show gratitude, thanks and recognising awesomeness to others in
              your team
            </p>

            <div className={styles.formRow}>
              <div className={styles.formColumn}>
                <div className={styles.formGroup}>
                  <label htmlFor="send-zaps-recipient" className={styles.label}>
                    Send zaps to
                  </label>
                  <select
                    id="send-zaps-recipient"
                    value={selectedUser}
                    onChange={e => handleUserSelect(e.target.value)}
                    className={styles.select}
                    disabled={isLoadingUsers}
                  >
                    <option value="">
                      {isLoadingUsers ? 'Loading users...' : 'Select a person'}
                    </option>
                    {!isLoadingUsers &&
                      users
                        .filter(user => {
                          const isGuid = /^[a-f0-9]{32}$/i.test(
                            user.displayName || '',
                          );
                          const hasValidName = user.displayName && !isGuid;
                          const hasEmail =
                            user.email && user.email.includes('@');
                          return hasValidName || hasEmail;
                        })
                        .map(user => {
                          const isGuid = /^[a-f0-9]{32}$/i.test(
                            user.displayName || '',
                          );
                          const displayText =
                            !user.displayName || isGuid
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

                {!isLoadingUsers && users.length > 0 && (
                  <p className={styles.hintText}>
                    {users.length} team member{users.length !== 1 ? 's' : ''}{' '}
                    available
                  </p>
                )}

                <div className={styles.formGroup}>
                  <label htmlFor="send-zaps-value" className={styles.label}>
                    Value
                  </label>
                  <select
                    id="send-zaps-value"
                    value={selectedValue}
                    onChange={e => setSelectedValue(e.target.value)}
                    className={styles.select}
                  >
                    <option value="">Select a value</option>
                    <option value="teamwork">Teamwork</option>
                    <option value="innovation">Innovation</option>
                    <option value="excellence">Excellence</option>
                    <option value="integrity">Integrity</option>
                  </select>
                </div>
              </div>

              <div className={styles.formColumn}>
                <div className={styles.formGroup}>
                  <label htmlFor="send-zaps-amount" className={styles.label}>
                    Specify amount
                  </label>
                  <div className={styles.amountInputRow}>
                    <input
                      id="send-zaps-amount"
                      type="number"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      placeholder="0"
                      min="1"
                      step="1"
                      className={styles.amountInput}
                    />
                    <span className={styles.currencyLabel}>
                      {rewardName ?? 'Unavailable'}
                    </span>
                  </div>
                </div>

                <div
                  className={styles.presetAmounts}
                  role="group"
                  aria-label="Quick amounts"
                >
                  {PRESET_AMOUNTS.map((preset, index) => (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => handlePresetAmount(preset)}
                      aria-pressed={amount === preset.toString()}
                      className={
                        amount === preset.toString()
                          ? styles.presetChipActive
                          : index === 0
                            ? styles.presetChipFeatured
                            : styles.presetChip
                      }
                    >
                      {preset.toLocaleString()}
                    </button>
                  ))}
                </div>

                <p className={styles.balanceText}>
                  Available balance:{' '}
                  <b className={styles.balanceValue}>
                    {currentUserWallets.balance === null
                      ? 'Loading...'
                      : rewardName
                        ? `${currentUserWallets.balance.toLocaleString()} ${rewardName}`
                        : 'Reward name unavailable'}
                  </b>
                </p>
              </div>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="send-zaps-description" className={styles.label}>
                Description
              </label>
              <textarea
                id="send-zaps-description"
                value={memo}
                onChange={e => setMemo(e.target.value)}
                placeholder="What are these zaps for?"
                className={styles.textarea}
                rows={3}
              />
            </div>

            {selectedUserData && (
              <div className={styles.summary}>
                <span className={styles.summaryAvatar} aria-hidden="true">
                  {getInitials(recipientName)}
                </span>
                <span className={styles.summaryText}>
                  <b className={styles.summaryName}>{recipientName}</b>
                  {amountIsValid ? (
                    <>
                      {' '}
                      will receive{' '}
                      <b className={styles.summaryAmount}>
                        {numericAmount.toLocaleString()} {rewardName}
                      </b>
                      {sendAnonymously ? ' anonymously' : ''}
                    </>
                  ) : (
                    <> — choose an amount to continue</>
                  )}
                </span>
              </div>
            )}

            {error && (
              <div className={styles.errorBanner} role="alert">
                <img src={dismissIcon} alt="" className={styles.errorIcon} />
                <span className={styles.errorText}>{error}</span>
                <button
                  type="button"
                  className={styles.errorDismiss}
                  onClick={() => setError(null)}
                >
                  Dismiss
                </button>
              </div>
            )}

            <div className={styles.actionRow}>
              <div className={styles.leftActions}>
                <button
                  onClick={handleClose}
                  className={styles.cancelButton}
                  disabled={isLoading}
                >
                  Cancel
                </button>
              </div>

              <div className={styles.rightActions}>
                <label
                  className={styles.checkboxLabel}
                  htmlFor="send-zaps-anonymous"
                >
                  <input
                    id="send-zaps-anonymous"
                    type="checkbox"
                    checked={sendAnonymously}
                    onChange={e => setSendAnonymously(e.target.checked)}
                    className={styles.checkbox}
                  />
                  Send anonymously
                </label>

                <button
                  onClick={handleSendZap}
                  className={styles.sendButton}
                  disabled={isSendDisabled || isLoading}
                >
                  {isLoading ? (
                    <>
                      <span className={styles.spinner} aria-hidden="true" />
                      Sending...
                    </>
                  ) : (
                    'Send'
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {success && (
        <div
          className={styles.successPopup}
          role="dialog"
          aria-modal="true"
          aria-labelledby="send-zaps-success-title"
        >
          <div className={styles.popupHeader} role="status">
            <img src={checkmarkIcon} alt="" className={styles.statusIcon} />
            <div id="send-zaps-success-title" className={styles.popupText}>
              Zap sent successfully!
            </div>
          </div>
          <div className={styles.successSummary}>
            <span className={styles.successAmount}>
              {amountIsValid && rewardName
                ? `+${numericAmount.toLocaleString()} ${rewardName}`
                : 'Zap sent'}
            </span>
            {selectedUserData && (
              <span className={styles.successRecipient}>
                to <b className={styles.summaryName}>{recipientName}</b>
                {sendAnonymously ? ' (sent anonymously)' : ''}
              </span>
            )}
          </div>
          {paymentHash && (
            <div className={styles.transactionId}>
              <span className={styles.transactionLabel}>Transaction ID:</span>
              <span className={styles.transactionHash}>
                {paymentHash.substring(0, 16)}...
              </span>
            </div>
          )}
          <button className={styles.closeButton} onClick={handleClose}>
            Close
          </button>
        </div>
      )}
    </div>
  );
};

export default SendZapsPopup;
