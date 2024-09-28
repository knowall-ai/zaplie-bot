import React, { FunctionComponent, useState, useEffect, useRef } from 'react';
import styles from './RewardsComponent.module.css';
import {
  getNostrRewards,
  getUserWallets,
} from '../services/lnbitsServiceLocal';
import PurchasePopup from './PurchasePopup';
import ProvidedBy from '../images/ProvidedBy.svg';

const stallID = process.env.REACT_APP_LNBITS_STORE_ID as string;

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
      const privateWallet = wallets?.find(wallet => wallet.name === 'Private');
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

  // Only render rewards if they exist
  return (
    <div className={styles.mainContainer}>
      <div className={styles.title}>Rewards <img src={ProvidedBy} alt="Provided By" className={styles.providedByImage} /></div>
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
                src={reward.image}
                alt={reward.name}
                className={styles.rewardImage}
                style={{ height: '160px' }} // Fixed height
              />
              <h3 className={styles.cardTitle}>{reward.name}</h3>
              <p className={styles.cardDescription}>
                {reward.shortDescription}
              </p>
              <p
                className={styles.productDetails}
                onClick={() => handleProductDetailsClick(reward.link)}
              >
                Product details
              </p>
              <div className={styles.priceContainer}>
                <p className={styles.price}>{formatPrice(reward.price)}</p>
                <p className={styles.sats}>Sats</p>
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
          <p className={styles.noPointer}>No rewards available</p>
        )}
      </div>
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
