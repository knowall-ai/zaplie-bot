import React from 'react';
import Image0 from '../images/Battery0.svg';
import Image1 from '../images/Battery1.png';
import Image2 from '../images/Battery2.png';
import Image3 from '../images/Battery3.png';
import Image4 from '../images/Battery4.png';
import Image5 from '../images/Battery5.png';

interface BatteryImageDisplayProps {
  value: number;
}

const BatteryImageDisplay: React.FC<BatteryImageDisplayProps> = ({ value }) => {
  let imageSrc = '';

if (value < 1) {

    imageSrc = Image0;
}
    else if (value >= 1 && value <= 20) {
        imageSrc = Image1;
  } else if (value > 20 && value <= 40) {
    imageSrc = Image2;
  } else if (value > 40 && value <= 60) {
    imageSrc = Image3;
  } else if (value > 60 && value <= 80) {
    imageSrc = Image4;
  } else {
    imageSrc = Image5;
  }

  return (
    <div>
      <img
        src={imageSrc}
        alt="Battery Level"
        style={{
          filter: 'hue-rotate(45deg) saturate(1.2) brightness(1.1)'
        }}
      />
    </div>
  );
};

export default BatteryImageDisplay;