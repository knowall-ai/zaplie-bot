import React, { useEffect, useState, useContext } from 'react';
import './WalletAllowanceComponent.css'; // Assuming you'll use CSS for styling
import BatteryImageDisplay from './BatteryImageDisplay';
import ArrowClockwise from '../images/ArrowClockwise.svg';
import Calendar from '../images/Calendar.svg';
import { getWalletTransactionsSince } from '../services/wallet/payments';
import { getAllowance, getUsers } from '../services/wallet/users';
import { getUserWallets } from '../services/wallet/wallets';
import { isFunded } from '../services/wallet/walletSelection';
import { useMsal } from '@azure/msal-react';
import { RewardNameContext } from './RewardNameContext';
import SendZapsPopup from './SendZapsPopup';

// Time constants
const SECONDS_PER_DAY = 86400;
const MS_PER_SECOND = 1000;
const TRANSACTION_HISTORY_DAYS = 30;

interface AllowanceCardProps {
  // Define the props here if there are any, for example:
  // someProp: string;
}

const WalletAllowanceCard: React.FC<AllowanceCardProps> = () => {
  const [batteryPercentage, setBatteryPercentage] = useState(0);
  // null, not 0: a balance the gateway could not read must read as
  // "Unavailable", not as a spent allowance.
  const [balance, setBalance] = useState<number | null>(null);
  const [allowance, setAllowance] = useState<Allowance | null>(null);
  const [spentSats, setSpentSats] = useState(0);
  const [showSendZapsPopup, setShowSendZapsPopup] = useState(false);
  // calculate battery
  const { accounts } = useMsal();

  useEffect(() => {
    const account = accounts[0];

    if (!account?.localAccountId) {
      return;
    }

    const fetchAmountReceived = async () => {
      const user = await getUsers({
        aadObjectId: account.localAccountId,
      });

      if (user && user.length > 0) {
        const currentUser = user[0];

        // Fetch user's wallets
        const userWallets = await getUserWallets(currentUser.id);

        if (userWallets && userWallets.length > 0) {
          // Find the Allowance wallet
          const allowanceWallet = userWallets.find(w =>
            w.name.toLowerCase().includes('allowance'),
          );

          // `?? 0` here used to turn a balance the gateway could not read into
          // an empty-looking wallet and a 0% battery. A null balance now leaves
          // both the battery and the figure unset.
          setBalance(null);
          if (allowanceWallet && isFunded(allowanceWallet)) {
            const balance = allowanceWallet.balance_msat / 1000;
            setBalance(balance);

            const allowanceData = await getAllowance(currentUser.id);

            if (allowanceData) {
              setAllowance(allowanceData);
              const batteryPct = (balance / allowanceData.amount) * 100;
              setBatteryPercentage(batteryPct);
            } else {
              setAllowance(null);
            }

            if (allowanceWallet.id) {
              const transactionHistoryStart =
                Date.now() / MS_PER_SECOND -
                TRANSACTION_HISTORY_DAYS * SECONDS_PER_DAY;
              const transaction = await getWalletTransactionsSince(
                allowanceWallet.id,
                transactionHistoryStart,
                {},
              );

              const spent =
                transaction
                  .filter(t => t.amount < 0)
                  .reduce((total, t) => total + Math.abs(t.amount), 0) /
                MS_PER_SECOND;
              setSpentSats(spent);
            }
          }
        }
      }
    };

    fetchAmountReceived();
  }, [accounts]);
  const rewardNameContext = useContext(RewardNameContext);
  if (!rewardNameContext) {
    return null; // or handle the case where the context is not available
  }
  const rewardsName = rewardNameContext.rewardNameLabel;
  return (
    <>
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
            <div className="col-md-5">
              <div className="amountDisplayContainer">
                <div className="amountDisplay">
                  {balance === null ? 'Unavailable' : balance.toLocaleString()}
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

            <div
              className="col-md-6"
              style={{ display: 'flex', alignItems: 'center', gap: '160px' }}
            >
              {/* Without an allowance figure there is no denominator, so the
                  gauge would read empty on a full wallet. */}
              {allowance && <BatteryImageDisplay value={batteryPercentage} />}
              <button
                className="sendZapsButton"
                onClick={() => setShowSendZapsPopup(true)}
                style={{ width: 'auto' }}
              >
                Send some zaps
              </button>
            </div>
          </div>
          <div
            className="row"
            style={{ paddingTop: '20px', paddingBottom: '20px' }}
          >
            <div className="col-md-5">
              {allowance && (
                <div className="nextAllwanceContainer">
                  <img src={Calendar} alt="" />
                  <div className="remaining smallTextFont">Next allowance</div>
                  <div className="remaining smallTextFont">
                    {allowance.amount.toLocaleString()}{' '}
                    <span>{rewardsName}</span>
                  </div>
                  <div className="remaining smallTextFont">
                    <div>
                      {new Date(allowance.nextPaymentDate).toLocaleDateString(
                        'en-US',
                        {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        },
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <div className="col-md-3">
              <div className="remaining smallTextFont">
                <span className="color-box remaining-color "></span>Remaining
                this week:
              </div>
              <div className="spent smallTextFont">
                <span className="color-box spent-color"></span>Spent this week:
              </div>
            </div>
            <div className="col-md-3">
              <div className="spent smallTextFont">
                <b>
                  {balance === null ? 'Unavailable' : balance.toLocaleString()}
                </b>{' '}
                {rewardsName}
              </div>
              <div className="spent smallTextFont">
                <b>{spentSats?.toLocaleString()}</b> {rewardsName}
              </div>
            </div>
          </div>
        </div>
      </div>
      {showSendZapsPopup && (
        <SendZapsPopup onClose={() => setShowSendZapsPopup(false)} />
      )}
    </>
  );
};

export default WalletAllowanceCard;
