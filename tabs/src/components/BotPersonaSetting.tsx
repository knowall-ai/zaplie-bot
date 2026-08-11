import React, { FunctionComponent, useState, useEffect } from 'react';
import styles from './setting.module.css';
import { getBotPersona, updateBotPersona } from '../apiService';
import { ToastContainer, toast } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const BotPersonaSetting: FunctionComponent = () => {
  const [isEditing, setIsEditing] = useState(false);
  const [persona, setPersona] = useState('');

  useEffect(() => {
    const fetchBotPersona = async () => {
      try {
        const data = await getBotPersona();
        setPersona(data.botPersona);
      } catch (error) {
        console.error('Error fetching bot persona:', error);
        toast.error('Error fetching bot persona.');
      }
    };

    fetchBotPersona();
  }, []);

  const handleEditClick = () => {
    setIsEditing(true);
  };

  const handleSaveClick = async () => {
    setIsEditing(false);
    try {
      const data = await updateBotPersona(persona);
      setPersona(data.botPersona);
      toast.success('Bot persona has been updated successfully!');
    } catch (error) {
      console.error('Error updating bot persona:', error);
      toast.error('Error updating bot persona.');
    }
  };

  return (
    <div className={styles.currencySetting}>
      <label className={styles.label}>Bot Persona / Prompt</label>
      <div className={`${styles.inputGroup} ${styles.textAreaGroup}`}>
        <textarea
          value={persona}
          onChange={(e) => setPersona(e.target.value)}
          disabled={!isEditing}
          className={`${styles.textArea} ${isEditing ? styles.editing : ''}`}
          title="Bot persona"
          placeholder="Describe the bot's tone, name, and organization vocabulary"
          rows={6}
        />
        {!isEditing ? (
          <button onClick={handleEditClick} className={styles.editButton}>
            Edit
          </button>
        ) : (
          <button onClick={handleSaveClick} className={styles.saveButton}>
            Save
          </button>
        )}
      </div>
      <ToastContainer />
    </div>
  );
};

export default BotPersonaSetting;
