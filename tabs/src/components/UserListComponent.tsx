import { FunctionComponent, useEffect, useState, useRef, useContext } from 'react';
import styles from './UserListComponent.module.css';
import { getUsers } from '../services/lnbitsServiceLocal';
import { useCache } from '../utils/CacheContext';
import { RewardNameContext } from './RewardNameContext';

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

const UserListComponent: FunctionComponent = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [users, setUsers] = useState<User[]>([]);
  const fetchCalled = useRef(false); // Ref to track if fetchUsers has been called
  const { cache, setCache } = useCache();

  const fetchUsers = async () => {
    //Load users from Cache or paraneter
    console.log('load all ALL users in USERS');
    setLoading(true);
    setError(null);

    const allUsers = cache['allUsers'] as User[];
    console.log('load all users in USER comp', allUsers);
    setUsers(allUsers);
    setLoading(false);
    
  };

  useEffect(() => {
    
    if (!fetchCalled.current) {
      fetchCalled.current = true;
      fetchUsers();
    }
  }, []);
  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
const rewardsName = rewardNameContext.rewardName;
  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>{error}</div>;
  }  


  return (
    <div className={styles.userslist}>
      <b className={styles.users}>Users</b>
      <div className={styles.tabs}>
        <div className={styles.tab}>
          <div className={styles.base}>
            <div className={styles.stringBadgeIconStack}>
              <b className={styles.stringTabTitle}>All</b>
            </div>
            <div className={styles.borderPaddingStack}>
              <div className={styles.borderBottom} />
            </div>
          </div>
        </div>
        <div className={styles.tab} style={{ display: 'none' }}>
          <div className={styles.base1}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>Teammates</div>
            </div>
          </div>
        </div>
        <div className={styles.tab} style={{ display: 'none' }}>
          <div className={styles.base1}>
            <div className={styles.stringBadgeIconStack}>
              <div className={styles.stringTabTitle}>Copilots</div>
            </div>
          </div>
        </div>
      </div>
      <div className={styles.list}>
        <div className={styles.headercell}>
          <div className={styles.headerContents}>
            <div className={styles.stringParent}>
              <b className={styles.string}>User</b>
              <b className={styles.string1}>User type</b>
              <b className={styles.string2}>Balance</b>
              <b className={styles.string3}>Allowance remaining</b>
            </div>
          </div>
        </div>
        {users
          ?.sort((a, b) => a.displayName.localeCompare(b.displayName))
          .map(user => (
            <div key={user.id} className={styles.bodycell}>
              <div className={styles.bodyContents}>
                <div className={styles.mainContentStack}>
                  <div className={styles.personDetails}>
                    <img
                      className={styles.avatarIcon}
                      alt=""
                      src={user.profileImg ? user.profileImg : 'profile.png'}
                    />
                    <div className={styles.userName}>{user.displayName}</div>
                  </div>
                  <div className={styles.totalBalance}>
                    {user.type ? user.type : 'Teammate'}
                  </div>
                  <b className={styles.totalBalance1}>
                    {user.privateWallet
                      ? `${Math.floor(
                          user.privateWallet.balance_msat / 1000,
                        )} ${rewardsName}`
                      : 'N/A'}
                  </b>
                  <b className={styles.totalBalance2}>
                    {user.allowanceWallet
                      ? `${Math.floor(
                          user.allowanceWallet.balance_msat / 1000,
                        )} ${rewardsName}`
                      : 'N/A'}
                  </b>
                </div>
                <div className={styles.actions} />
              </div>
            </div>
          ))}
      </div>
      <div className={styles.poweredby}>
        <div className={styles.poweredBy}>
          <b className={styles.poweredBy1}>Powered by</b>
          <img className={styles.logo1Icon} alt="" src="LNbits.png" />
        </div>
      </div>
    </div>
  );
};

export default UserListComponent;
