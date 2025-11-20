import React, { useEffect, useState, useContext } from 'react';
import './WalletAllowanceComponent.css'; // Assuming you'll use CSS for styling
import BatteryImageDisplay from './BatteryImageDisplay';
import ArrowClockwise from '../images/ArrowClockwise.svg';
import Calendar from '../images/Calendar.svg';
import { getAllowance, getUsers, getUserWallets, getWalletTransactionsSince } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import WalletTransactionLog from './WalletTransactionLog';
import { RewardNameContext } from './RewardNameContext';

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;
let spentSats =0

interface AllowanceCardProps {
  // Define the props here if there are any, for example:
  // someProp: string;
}

const WalletAllowanceCard: React.FC<AllowanceCardProps> = () => {
  const [batteryPercentage, setBatteryPercentage] = useState(0);
  const [balance, setBalance] = useState<number>(0);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [spentSats, setSpentSats] = useState(0);
  // calculate battery
  const { accounts } = useMsal();

  useEffect(() => {
    const account = accounts[0];
    console.log('=== WalletAllowanceCard: useEffect triggered ===');
    console.log('WalletAllowanceCard: account =', account);

    if (!account?.localAccountId) {
      console.log('WalletAllowanceCard: No account.localAccountId, returning early');
      return;
    }

    const fetchAmountReceived = async () => {
      console.log('WalletAllowanceCard: Fetching allowance wallet...');
      console.log('WalletAllowanceCard: account.localAccountId =', account.localAccountId);

      const user = await getUsers(adminKey, {
        aadObjectId: account.localAccountId,
      });

      console.log('WalletAllowanceCard: Users returned from getUsers =', user);

      if (user && user.length > 0) {
        const currentUser = user[0];
        console.log('WalletAllowanceCard: Current user =', currentUser);
        console.log('WalletAllowanceCard: Current user.id =', currentUser.id);

        // Fetch user's wallets
        const userWallets = await getUserWallets(adminKey, currentUser.id);
        console.log('WalletAllowanceCard: User wallets returned =', userWallets);

        if (userWallets && userWallets.length > 0) {
          console.log('WalletAllowanceCard: Searching for Allowance wallet in', userWallets.length, 'wallets');
          userWallets.forEach(w => {
            console.log('WalletAllowanceCard: Wallet name:', w.name, '| balance_msat:', w.balance_msat);
          });

          // Find the Allowance wallet
          const allowanceWallet = userWallets.find(w =>
            w.name.toLowerCase().includes('allowance')
          );

          console.log('WalletAllowanceCard: Allowance wallet found?', !!allowanceWallet);
          if (allowanceWallet) {
            console.log('WalletAllowanceCard: Allowance wallet details:', allowanceWallet);
            console.log('WalletAllowanceCard: balance_msat =', allowanceWallet.balance_msat);

            const balance = (allowanceWallet.balance_msat ?? 0) / 1000;
            console.log('WalletAllowanceCard: Calculated balance (sats) =', balance);
            setBalance(balance);

            const allowanceData = await getAllowance(adminKey, currentUser.id);
            console.log('WalletAllowanceCard: Allowance data =', allowanceData);

            if (allowanceData) {
              setAllowance(allowanceData);
              const batteryPct = (balance / allowanceData.amount) * 100;
              console.log('WalletAllowanceCard: Battery percentage =', batteryPct);
              setBatteryPercentage(batteryPct);
            } else {
              console.log('WalletAllowanceCard: No allowance data found');
              setAllowance(null);
            }

            const sevenDaysAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
            const encodedExtra = {};
            const transaction = await getWalletTransactionsSince(
              allowanceWallet.inkey,
              sevenDaysAgo,
              encodedExtra
            );
            console.log('WalletAllowanceCard: Transactions retrieved =', transaction);

            const spent = transaction
              .filter(transaction => transaction.amount < 0)
              .reduce((total, transaction) => total + Math.abs(transaction.amount), 0) / 1000;
            console.log('WalletAllowanceCard: Spent sats =', spent);
            setSpentSats(spent);
          } else {
            console.log('WalletAllowanceCard: ERROR - Allowance wallet not found!');
          }
        } else {
          console.log('WalletAllowanceCard: ERROR - No wallets returned for user');
        }
      } else {
        console.log('WalletAllowanceCard: ERROR - No users found for aadObjectId:', account.localAccountId);
      }
    };

    fetchAmountReceived();
  }, [accounts]);
  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
const rewardsName = rewardNameContext.rewardName;
  return (
    <div className="wallet-container">
      <div className="wallet-header">
        <h4>Allowance</h4>
        <p>Amount available to send to your teammates:</p>
      </div>
      <div className="mainContent">
        <div
          className="row"
          style={{ paddingTop: '20px', paddingBottom: '20px' }}
        >
          <div className="col-md-6">
            <div className="amountDisplayContainer">
              <div className="amountDisplay">
                {balance?.toLocaleString() ?? '0'}
              </div>
              <div>{rewardsName}</div>
              <div style={{ paddingLeft: '20px', display: 'none' }}>
                <button className="refreshImageIcon">
                  <img
                    src={ArrowClockwise}
                    alt="icon"
                    style={{ width: 30, height: 30 }}
                  />
                </button>
              </div>
            </div>
          </div>

          <div className="col-md-3">
            <BatteryImageDisplay value={batteryPercentage} />
          </div>
        </div>
        <div
          className="row"
          style={{ paddingTop: '20px', paddingBottom: '20px' }}
        >
          <div className="col-md-6">
            <div className="nextAllwanceContainer">
              <img src={Calendar} alt="" />
              <div className="remaining smallTextFont">Next allowance</div>
              <div className="remaining smallTextFont">
                {allowance ? allowance.amount.toLocaleString() : '0'}{' '}
                <span>{rewardsName}</span>
              </div>
              <div className="remaining smallTextFont">
                <div>
                  {allowance
                    ? new Date(allowance.nextPaymentDate).toLocaleDateString(
                        'en-US',
                        {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        },
                      )
                    : 'TBC'}
                </div>
              </div>
            </div>
          </div>
          <div className="col-md-3">
            <div className="remaining smallTextFont">
              <span className="color-box remaining-color "></span>Remaining this
              week:
            </div>
            <div className="spent smallTextFont">
              <span className="color-box spent-color"></span>Spent this week:
            </div>
          </div>
          <div className="col-md-3">
            <div className="spent smallTextFont">
              <b>{balance?.toLocaleString() ?? '0'}</b> {rewardsName}
            </div>
            <div className="spent smallTextFont">
              <b>{spentSats?.toLocaleString()}</b> {rewardsName}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WalletAllowanceCard;
