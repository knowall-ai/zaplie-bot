import axios from 'axios';

const API_URL = '/api/connections';

export interface RepoConnection {
  id: number;
  fullName: string;
  private: boolean;
  htmlUrl: string;
}

export interface GithubRepos {
  connected: boolean;
  repositories: RepoConnection[];
}

export const getGithubInstallUrl = async (idToken: string): Promise<string> => {
  const response = await axios.post(
    `${API_URL}/github/install-url`,
    {},
    { headers: { Authorization: `Bearer ${idToken}` } },
  );
  return response.data.installUrl;
};

export const getGithubConnection = async (
  idToken: string,
): Promise<{ connected: boolean }> => {
  const response = await axios.get(`${API_URL}/github`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};

export const getGithubRepos = async (idToken: string): Promise<GithubRepos> => {
  const response = await axios.get(`${API_URL}/github/repos`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  return response.data;
};
