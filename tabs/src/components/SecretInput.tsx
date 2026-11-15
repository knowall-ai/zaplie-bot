import React, { FunctionComponent, useState } from 'react';
import styles from './setting.module.css';

interface SecretInputProps {
  id?: string;
  label?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  describedBy?: string;
}

// A password-type field with a Show/Hide toggle, for tokens and connection
// strings that are pasted once and never read back.
const SecretInput: FunctionComponent<SecretInputProps> = ({
  id,
  label,
  value,
  onChange,
  disabled,
  placeholder,
  describedBy,
}) => {
  const [visible, setVisible] = useState(false);
  return (
    <div className={styles.secretField}>
      <input
        id={id}
        aria-label={label}
        aria-describedby={describedBy}
        type={visible ? 'text' : 'password'}
        autoComplete="off"
        spellCheck={false}
        className={`${styles.textBox} ${styles.editing}`}
        placeholder={placeholder}
        value={value}
        onChange={event => onChange(event.target.value)}
        disabled={disabled}
      />
      <button
        type="button"
        className={styles.revealButton}
        aria-controls={id}
        aria-label={label ? `${visible ? 'Hide' : 'Show'} ${label}` : undefined}
        onClick={() => setVisible(previous => !previous)}
        disabled={disabled}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
};

export default SecretInput;
