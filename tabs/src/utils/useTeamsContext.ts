import { useState, useEffect } from 'react';
import { app } from '@microsoft/teams-js';

/**
 * Custom hook to detect if the app is running inside Microsoft Teams
 * @returns {boolean} isInTeams - true if running in Teams, false otherwise
 */
export const useTeamsContext = (): boolean => {
  const [isInTeams, setIsInTeams] = useState<boolean>(false);

  useEffect(() => {
    // Try to initialize Teams SDK
    app
      .initialize()
      .then(() => {
        // If initialization succeeds, we're in Teams
        app.getContext().then(() => {
          setIsInTeams(true);
        }).catch(() => {
          // Context retrieval failed, not in Teams
          setIsInTeams(false);
        });
      })
      .catch(() => {
        // Initialization failed, running as standalone web app
        setIsInTeams(false);
      });
  }, []);

  return isInTeams;
};
