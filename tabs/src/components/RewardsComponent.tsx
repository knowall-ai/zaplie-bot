import React, {
  FunctionComponent,
  useState,
  useEffect,
  useRef,
  useContext,
} from 'react';
import axios from 'axios';
import { useMsal } from '@azure/msal-react';
import styles from './RewardsComponent.module.css';
import {
  getNostrRewards,
  getUserWallets,
} from '../services/lnbitsServiceLocal';
import PurchasePopup from './PurchasePopup';
import imagePlaceholder from '../images/imagePlaceholderNew.svg';
import { RewardNameContext } from './RewardNameContext';
import { loginRequest } from '../services/authConfig';
import { isZaplieAdmin } from '../services/adminRole';
import {
  getTeamRewards,
  redeemTeamReward,
  fulfillRedemption,
  TeamReward,
  RedemptionHistoryEntry,
} from '../services/teamRewardsService';
import RewardCertification from '../images/reward-certification.webp';
import RewardCourse from '../images/reward-course.webp';
import RewardConference from '../images/reward-conference.webp';
import RewardRecharge from '../images/reward-recharge.webp';
import { toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const stallID = process.env.REACT_APP_LNBITS_STORE_ID as string;

// Photos for the default catalog ids; org-specific items render without one.
const TEAM_REWARD_IMAGES: Record<string, string> = {
  'certification-voucher': RewardCertification,
  'course-budget': RewardCourse,
  'conference-day': RewardConference,
  'recharge-day': RewardRecharge,
};

const RewardsComponent: FunctionComponent<{
  adminKey: string;
  userId: string;
}> = ({ adminKey, userId }) => {
  const [rewards, setRewards] = useState<Reward[]>([]); // Initialize as an empty array
  const [isDragging, setIsDragging] = useState(false);
  const [startPosition, setStartPosition] = useState(0);
  const [scrollPosition, setScrollPosition] = useState(0);
  const [showPopup, setShowPopup] = useState(false); // State to manage popup visibility
  const [selectedReward, setSelectedReward] = useState<Reward | null>(null); // State to store the selected reward
  const [userWallet, setUserWallet] = useState<Wallet | null>(null); // State to store the user's wallet
  const [hasEnoughSats, setHasEnoughSats] = useState<boolean>(false); // State to store if user has enough Sats
  const carouselRef = useRef<HTMLDivElement>(null);

  const { instance, accounts } = useMsal();
  const isAdmin = isZaplieAdmin(accounts[0]);
  const [teamRewards, setTeamRewards] = useState<TeamReward[]>([]);
  const [requestedIds, setRequestedIds] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<RedemptionHistoryEntry[]>([]);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);

  const acquireIdToken = async () => {
    // forceRefresh: acquireTokenSilent can serve a cached, already-expired
    // idToken; the backend verifies exp and would reject it with a 401.
    const tokenResponse = await instance.acquireTokenSilent({
      ...loginRequest,
      account: accounts[0],
      forceRefresh: true,
    });
    return tokenResponse.idToken;
  };

  const load = async () => {
    try {
      const data = await getTeamRewards(await acquireIdToken());
      setTeamRewards(data.rewards);
      setRequestedIds(new Set(data.myRequests));
      setHistory(data.history);
    } catch (error) {
      console.error('Error fetching team rewards:', error);
      toast.error('Could not load team rewards.');
    }
  };

  useEffect(() => {
    if (!accounts[0]) {
      return;
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, instance]);

  const handleRedeem = async (reward: TeamReward) => {
    setRedeemingId(reward.id);
    try {
      await redeemTeamReward(await acquireIdToken(), reward.id);
      setRequestedIds(previous => new Set(previous).add(reward.id));
      await load();
      toast.success(
        `Redeemed for ${new Intl.NumberFormat('en-US').format(reward.priceSats)} ${rewardName}. Your admin will arrange "${reward.name}".`,
      );
    } catch (error) {
      console.error('Error redeeming team reward:', error);
      const status = axios.isAxiosError(error)
        ? error.response?.status
        : undefined;
      if (status === 402) {
        toast.error('Not enough sats in your Private wallet for this reward.');
      } else if (status === 409) {
        toast.error('You already have a pending request for this reward.');
      } else {
        toast.error('Could not complete the redemption.');
      }
    } finally {
      setRedeemingId(null);
    }
  };

  useEffect(() => {
    const fetchRewards = async () => {
      const stallId = stallID;

      try {
        const rewardsData = await getNostrRewards(adminKey, stallId);

        if (!rewardsData) {
          throw new Error('No data returned from API');
        }

        // Map API data to Rewards format
        const transformedRewards = rewardsData.map((product: any) => ({
          id: product.id,
          image: product.images[0],
          name: product.name,
          shortDescription: product.config.description,
          link: product.categories,
          price: product.price,
        }));

        setRewards(transformedRewards); // Update state with transformed rewards
      } catch (error) {
        console.error('Error fetching rewards:', error);
      }
    };

    fetchRewards();
  }, [adminKey]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (carouselRef.current) {
      setIsDragging(true);
      setStartPosition(e.pageX - carouselRef.current.offsetLeft);
      setScrollPosition(carouselRef.current.scrollLeft);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging && carouselRef.current) {
      const x = e.pageX - carouselRef.current.offsetLeft;
      const walk = (x - startPosition) * 1; // Scrolling speed factor
      carouselRef.current.scrollLeft = scrollPosition - walk;
    }
  };

  const handleMouseUp = () => {
    setIsDragging(false);
  };

  const handleProductDetailsClick = (url: string) => {
    window.open(url, '_blank');
  };

  const formatPrice = (price: number) => {
    return new Intl.NumberFormat('en-US').format(price);
  };

  const handleBuyClick = async (price: number, reward: Reward) => {
    try {
      const wallets = await getUserWallets(adminKey, userId);
      console.log('wallets:-', wallets);
      const privateWallet = wallets?.find(wallet => wallet.name === 'Private');
      console.log('privateWallet:-', privateWallet);
      if (privateWallet) {
        setUserWallet(privateWallet);
        setHasEnoughSats(privateWallet.balance_msat / 1000 >= price);
        setSelectedReward(reward);
        setShowPopup(true);
      } else {
        console.error('No private wallet found for the user');
      }
    } catch (error) {
      console.error('Error fetching user wallet:', error);
    }
  };

  const handleClosePopup = () => {
    setShowPopup(false);
  };

  const rewardNameContext = useContext(RewardNameContext);
  const rewardName = rewardNameContext.rewardName;

  // Only render rewards if they exist
  return (
    <div className={styles.mainContainer}>
      <div className={styles.title}>Rewards</div>
      <div
        className={styles.carousel}
        ref={carouselRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
      >
        {rewards.length > 0 ? ( // Check if rewards array has elements
          rewards.map(reward => (
            <div key={reward.id} className={styles.card}>
              <img
                src={
                  reward.image && reward.image.length > 0
                    ? reward.image
                    : imagePlaceholder
                }
                alt={reward.name}
                className={styles.rewardImage}
                style={{ height: '160px' }} // Fixed height
              />
              <h3 className={styles.cardTitle}>{reward.name}</h3>
              <p className={styles.cardDescription}>
                {reward.shortDescription.length > 140
                  ? `${reward.shortDescription.substring(0, 140)}...`
                  : reward.shortDescription}
              </p>
              {reward.link && reward.link.length > 0 && (
                <p
                  className={styles.productDetails}
                  onClick={() => handleProductDetailsClick(reward.link)}
                >
                  Product details
                </p>
              )}

              <div className={styles.priceContainer}>
                <p className={styles.price}>{formatPrice(reward.price)}</p>
                <p className={styles.sats}>{rewardName}</p>
              </div>
              <button
                className={styles.buyButton}
                onClick={() => handleBuyClick(reward.price, reward)}
              >
                Buy
              </button>
            </div>
          ))
        ) : (
          <p className={styles.noPointer}>
            No marketplace products available yet.
          </p>
        )}
      </div>
      <div className={styles.teamSection}>
        <h3 className={styles.teamTitle}>Team rewards</h3>
        <p className={styles.teamSubtitle}>
          Curated by your organisation. Redeeming pays from your Private wallet
          and files a request your admin fulfils.
        </p>
        <div className={styles.teamGrid}>
          {teamRewards.map(reward => (
            <div key={reward.id} className={styles.teamCard}>
              {TEAM_REWARD_IMAGES[reward.id] && (
                <img
                  src={TEAM_REWARD_IMAGES[reward.id]}
                  alt=""
                  className={styles.teamCardPhoto}
                />
              )}
              <span className={styles.categoryChip}>{reward.category}</span>
              <span className={styles.teamCardTitle}>{reward.name}</span>
              <p className={styles.teamCardDescription}>{reward.description}</p>
              <div className={styles.teamCardFooter}>
                <span className={styles.teamPrice}>
                  {new Intl.NumberFormat('en-US').format(reward.priceSats)}{' '}
                  {rewardName}
                </span>
                {requestedIds.has(reward.id) ? (
                  <span className={styles.requestedBadge}>Requested</span>
                ) : (
                  <button
                    className={styles.redeemButton}
                    disabled={redeemingId === reward.id}
                    onClick={() => handleRedeem(reward)}
                  >
                    {redeemingId === reward.id ? 'Sending...' : 'Redeem'}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
      {history.length > 0 && (
        <div className={styles.teamSection}>
          <h3 className={styles.teamTitle}>History</h3>
          <div className={styles.historyList}>
            {history.map(entry => (
              <div key={entry.id} className={styles.historyRow}>
                <div className={styles.historyInfo}>
                  <span className={styles.historyReward}>
                    {entry.rewardName}
                  </span>
                  <span className={styles.historyMeta}>
                    {new Date(entry.requestedAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short',
                    })}{' '}
                    · to {entry.personName} ·{' '}
                    {new Intl.NumberFormat('en-US').format(entry.priceSats)}{' '}
                    {rewardName}
                  </span>
                </div>
                <span
                  className={
                    entry.status === 'fulfilled'
                      ? styles.fulfilledBadge
                      : styles.pendingBadge
                  }
                >
                  {entry.status === 'fulfilled' ? 'Fulfilled' : 'Pending'}
                </span>
                {isAdmin && entry.status === 'requested' && (
                  <button
                    className={styles.fulfillButton}
                    onClick={async () => {
                      try {
                        await fulfillRedemption(
                          await acquireIdToken(),
                          entry.id,
                        );
                        setHistory(previous =>
                          previous.map(h =>
                            h.id === entry.id
                              ? { ...h, status: 'fulfilled' as const }
                              : h,
                          ),
                        );
                        toast.success(
                          `Marked "${entry.rewardName}" as fulfilled.`,
                        );
                      } catch (error) {
                        console.error('Error fulfilling redemption:', error);
                        toast.error(
                          'Could not mark the redemption as fulfilled.',
                        );
                      }
                    }}
                  >
                    Mark fulfilled
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {showPopup && userWallet && selectedReward && (
        <PurchasePopup
          onClose={handleClosePopup}
          wallet={userWallet}
          hasEnoughSats={hasEnoughSats}
          reward={selectedReward}
        />
      )}{' '}
      {/* Render popup if showPopup is true and userWallet is available */}
    </div>
  );
};

export default RewardsComponent;
