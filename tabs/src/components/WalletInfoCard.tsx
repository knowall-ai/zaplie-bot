import React, { useEffect, useState } from 'react';
import './WalletInfoCard.css';
import ArrowClockwise from '../images/ArrowClockwise.svg';
import { getUsers, getUserWallets } from '../services/lnbitsServiceLocal';
import { useMsal } from '@azure/msal-react';

// interface WalletYourWalletInfoCardProps {
//   totalSats: number;
// }

const adminKey = process.env.REACT_APP_LNBITS_ADMINKEY as string;

const WalletYourWalletInfoCard: React.FC = () => {
  const [balance, setBalance] = useState<number>();

  const { instance, accounts } = useMsal();
  const account = accounts[0];

  const fetchAmountReceived = async () => {
    console.log('Fetching your wallet ...');

    const currentUserLNbitDetails = await getUsers(adminKey, {
      aadObjectId: account.localAccountId,
    });

    if (currentUserLNbitDetails && currentUserLNbitDetails.length > 0) {
      if (currentUserLNbitDetails && currentUserLNbitDetails.length > 0) {
        const bal =
          (currentUserLNbitDetails[0].privateWallet?.balance_msat ?? 0) / 1000;
        setBalance(bal);
      }
    }
  };

  useEffect(() => {
    fetchAmountReceived();
  });

  return (
    <div className="wallet-info">
      <h4>Your wallet</h4>
      <p>Amount received from other users:</p>
      <div className="horizontal-container">
        <div className="item">
          {' '}
          <h1>{balance?.toLocaleString() ?? '0'}</h1>
        </div>
        <div className="item">Sats</div>
        <div
          className="col-md-1 item"
          style={{ paddingTop: '30px', paddingLeft: '10px' }}
        >
          <button style={{ display: 'none' }} className="refreshImageIcon">
            <img
              src={ArrowClockwise}
              alt="icon"
              style={{ width: 30, height: 30 }}
            />
          </button>
        </div>
      </div>
      <div className="row wallet-buttons">
        <div className="col-md-2">
          {' '}
          <button className="receive-btn">Receive</button>
        </div>
        <div className="col-md-2">
          <button className="send-btn">Send</button>
        </div>
        <div className="col-md-8">
          <span></span>
        </div>
      </div>
    </div>
  );
};

export default WalletYourWalletInfoCard;
