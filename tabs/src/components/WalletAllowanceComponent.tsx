import React, { useEffect, useState } from 'react';
import './WalletAllowanceComponent.css'; // Assuming you'll use CSS for styling
import BatteryImageDisplay from './BatteryImageDisplay';
import ArrowClockwise from '../images/ArrowClockwise.svg';
import Calendar from '../images/Calendar.svg';
import { getAllowance, getUsers, getWalletTransactionsSince } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';
import WalletTransactionLog from './WalletTransactionLog';

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

    const fetchAmountReceived = async () => {

      const user = await getUsers(adminKey, {
        aadObjectId: account.localAccountId,
      });

      if (user && user.length > 0) {
        const balance = (user[0].allowanceWallet?.balance_msat ?? 0) / 1000;
        setBalance(balance);

        const allowance = await getAllowance(adminKey, user[0].id);
        
        if (allowance) {
          setAllowance(allowance);
       
          setBatteryPercentage ((balance /allowance?.amount ) * 100);
          
        } else {
          setAllowance(null);
         const  batteryPercentage = 0;
        }
        const sevenDaysAgo = Date.now() / 1000 - 30 * 24 * 60 * 60;
        const encodedExtra = {}
       const userid = user[0].allowanceWallet?.inkey as string;
       const transaction = await getWalletTransactionsSince(userid,sevenDaysAgo,encodedExtra)
       setSpentSats (transaction.filter(transaction => transaction.amount < 0).reduce((total,transaction)=> total + Math.abs(transaction.amount),0) /1000)

      }
    };

    fetchAmountReceived();
  }, [accounts]);

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
              <div>Sats</div>
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
                <span>Sats</span>
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
              <b>{balance?.toLocaleString() ?? '0'}</b> Sats
            </div>
            <div className="spent smallTextFont">
              <b>{spentSats?.toLocaleString()}</b> Sats
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default WalletAllowanceCard;
