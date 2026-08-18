import {
  FunctionComponent,
  useEffect,
  useState,
  useRef,
  useContext,
  useCallback,
} from 'react';
import styles from './UserListComponent.module.css';
import { getUsers } from '../services/lnbits/users';
import { getUserWallets } from '../services/lnbits/wallets';
import { useCache } from '../utils/CacheContext';
import { RewardNameContext } from './RewardNameContext';
import {
  isFunded,
  selectWalletByName,
} from '../services/lnbits/walletSelection';

// The wallet lookup is one request per user. Browsers cap concurrent requests
// per host, so an unbounded fan-out leaves the surplus queued in the browser
// while the gateway client's 30s timeout runs down against the queued request
// rather than the server — late users then render with blank wallet columns.
export const WALLET_FETCH_CONCURRENCY = 5;

const mapWithConcurrency = async <TIn, TOut>(
  items: TIn[],
  limit: number,
  worker: (item: TIn) => Promise<TOut>,
): Promise<TOut[]> => {
  const results = new Array<TOut>(items.length);
  let next = 0;

  const runner = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => runner()),
  );

  return results;
};

// Fail closed on the *value*, not on the row: a substring match
// ("Private archive") or a wallet owned by somebody else is refused outright,
// but a duplicate name resolves to the oldest wallet rather than blanking the
// row, and a balance the gateway could not read renders as "Unavailable"
// instead of a plausible-looking zero.
export const selectOwnedWallet = (
  wallets: Wallet[],
  userId: string,
  name: string,
): Wallet | null => selectWalletByName(wallets, userId, name).wallet;

const formatBalance = (wallet: Wallet | null, unit: string): string =>
  wallet && isFunded(wallet)
    ? `${Math.floor(wallet.balance_msat / 1000).toLocaleString()} ${unit}`
    : 'Unavailable';

const UserListComponent: FunctionComponent = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const fetchCalled = useRef(false); // Ref to track if fetchUsers has been called
  const { cache, setCache } = useCache();

  const fetchUsers = useCallback(async () => {
    //Load users from Cache or parameter
    setLoading(true);
    setError(null);

    try {
      const cachedUsers = cache['allUsers'] as User[] | undefined;
      let allUsers: User[];

      // An empty cached directory is treated as a cold cache, matching
      // SendZapsPopup: a stale empty entry must not render an empty table.
      if (Array.isArray(cachedUsers) && cachedUsers.length > 0) {
        allUsers = cachedUsers;
      } else {
        allUsers = await getUsers();
        setCache('allUsers', allUsers);
      }

      // Service and test accounts have no linked Entra identity; the
      // directory only lists teammates who can actually use Teams.
      const linkedUsers = allUsers.filter(user => user.aadObjectId);

      // Fetch wallets for each user, a bounded number of requests at a time
      const usersWithWallets = await mapWithConcurrency(
        linkedUsers,
        WALLET_FETCH_CONCURRENCY,
        async user => {
          try {
            const wallets = await getUserWallets(user.id);

            return {
              ...user,
              privateWallet: selectOwnedWallet(wallets, user.id, 'private'),
              allowanceWallet: selectOwnedWallet(wallets, user.id, 'allowance'),
            };
          } catch (err) {
            console.error(
              `[UserList] Error fetching wallets for user ${user.displayName}:`,
              err,
            );
            return { ...user, privateWallet: null, allowanceWallet: null };
          }
        },
      );

      setUsers(usersWithWallets);
    } catch (err) {
      console.error('[UserList] Error:', err);
      setError(err instanceof Error ? err.message : 'An error occurred');
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

  const { rewardNameLabel } = useContext(RewardNameContext);

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
          {users.length === 0
            ? null
            : [...users]
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
                        user.privateWallet && isFunded(user.privateWallet)
                          ? styles.amount
                          : styles.amountMuted
                      }`}
                    >
                      {formatBalance(user.privateWallet, rewardNameLabel)}
                    </span>
                    <span
                      role="cell"
                      data-label="Allowance remaining"
                      className={`${styles.colAllowance} ${
                        user.allowanceWallet && isFunded(user.allowanceWallet)
                          ? styles.amount
                          : styles.amountMuted
                      }`}
                    >
                      {formatBalance(user.allowanceWallet, rewardNameLabel)}
                    </span>
                  </div>
                ))}
        </div>
      </div>
      {users.length === 0 && (
        /* Outside the table: role="status" is not a valid child of a table,
           and the message must be announced when loading finishes empty. */
        <p className={styles.stateMessage} role="status">
          No users found.
        </p>
      )}
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
