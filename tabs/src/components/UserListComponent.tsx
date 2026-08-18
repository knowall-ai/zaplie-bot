import {
  FunctionComponent,
  useEffect,
  useState,
  useRef,
  useContext,
  useCallback,
} from 'react';
import styles from './UserListComponent.module.css';
import { getUsers, getUserWallets } from '../services/lnbitsServiceLocal';
import { useCache } from '../utils/CacheContext';
import { RewardNameContext } from './RewardNameContext';

const UserListComponent: FunctionComponent = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const fetchCalled = useRef(false);
  const { cache, setCache } = useCache();

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const cachedUsers = cache['allUsers'];
      let allUsers: User[];

      if (Array.isArray(cachedUsers)) {
        allUsers = cachedUsers as User[];
      } else {
        allUsers = await getUsers();
        setCache('allUsers', allUsers);
      }

      const usersWithWallets = await Promise.all(
        allUsers.map(async user => {
          const wallets = await getUserWallets(user.id);
          const exactWallet = (name: string) => {
            const matches = wallets.filter(
              wallet => wallet.name.trim().toLowerCase() === name,
            );
            return matches.length === 1 ? matches[0] : null;
          };

          return {
            ...user,
            privateWallet: exactWallet('private'),
            allowanceWallet: exactWallet('allowance'),
          };
        }),
      );

      setUsers(usersWithWallets);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'The user directory is unavailable.',
      );
    } finally {
      setLoading(false);
    }
  }, [cache, setCache]);

  useEffect(() => {
    if (!fetchCalled.current) {
      fetchCalled.current = true;
      fetchUsers();
    }
  }, [fetchUsers]);
  const rewardNameContext = useContext(RewardNameContext);
  const rewardsName = rewardNameContext.rewardName;
  if (loading) {
    return (
      <div className={styles.stateMessage} role="status">
        Loading...
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.stateError} role="alert">
        <span>{error}</span>
        <button type="button" onClick={() => void fetchUsers()}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <section className={styles.userslist}>
      <h2 className={styles.users}>Users</h2>
      <div className={styles.tabs}>
        <div
          className={`${styles.tab} ${styles.tabActive}`}
          aria-current="true"
        >
          All
        </div>
        <div className={styles.tab} style={{ display: 'none' }}>
          Teammates
        </div>
        <div className={styles.tab} style={{ display: 'none' }}>
          Copilots
        </div>
      </div>
      <div className={styles.tableScroll}>
        <div className={styles.list} role="table" aria-label="Users">
          <div className={styles.headerRow} role="row">
            <span role="columnheader" className={styles.colUser}>
              User
            </span>
            <span role="columnheader" className={styles.colType}>
              User type
            </span>
            <span role="columnheader" className={styles.colBalance}>
              Balance
            </span>
            <span role="columnheader" className={styles.colAllowance}>
              Allowance remaining
            </span>
          </div>
          {[...users]
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
            .map(user => (
              <div key={user.id} className={styles.bodyRow} role="row">
                <span role="cell" className={styles.colUser}>
                  <img
                    className={styles.avatarIcon}
                    alt=""
                    src={user.profileImg ? user.profileImg : 'profile.png'}
                  />
                  <span className={styles.userName}>
                    {user.displayName &&
                    !user.displayName.match(/^[a-f0-9]{32}$/)
                      ? user.displayName
                      : user.email || 'Unknown'}
                  </span>
                </span>
                <span
                  role="cell"
                  className={styles.colType}
                  data-label="User type"
                >
                  {user.type || 'Not specified'}
                </span>
                <span
                  role="cell"
                  data-label="Balance"
                  className={`${styles.colBalance} ${
                    user.privateWallet ? styles.amount : styles.amountMuted
                  }`}
                >
                  {user.privateWallet
                    ? `${Math.floor(
                        user.privateWallet.balance_msat / 1000,
                      ).toLocaleString()} ${rewardsName}`
                    : 'Unavailable'}
                </span>
                <span
                  role="cell"
                  data-label="Allowance remaining"
                  className={`${styles.colAllowance} ${
                    user.allowanceWallet ? styles.amount : styles.amountMuted
                  }`}
                >
                  {user.allowanceWallet
                    ? `${Math.floor(
                        user.allowanceWallet.balance_msat / 1000,
                      ).toLocaleString()} ${rewardsName}`
                    : 'Unavailable'}
                </span>
              </div>
            ))}
        </div>
      </div>
      <div className={styles.poweredby}>
        <div className={styles.poweredBy}>
          <b className={styles.poweredBy1}>Powered by</b>
          <img className={styles.logo1Icon} alt="" src="LNbits.png" />
        </div>
      </div>
    </section>
  );
};

export default UserListComponent;
