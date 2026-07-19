import axios from 'axios';

export interface GithubSetupStatus {
  created: boolean;
  slug?: string;
  htmlUrl?: string;
}

// idToken (not the Graph access token): its audience is this app's own AAD
// client id, which is what the tab backend validates against the Entra JWKS.
const auth = (idToken: string) => ({ headers: { Authorization: `Bearer ${idToken}` } });

export const getGithubSetupStatus = async (idToken: string): Promise<GithubSetupStatus> => {
  const response = await axios.get('/api/setup/github/status', auth(idToken));
  return response.data;
};

// Submits a real form POST to github.com/settings/apps/new: GitHub only
// accepts the manifest as a posted form field, not as a redirect parameter.
export const startGithubAppCreation = async (idToken: string): Promise<void> => {
  const response = await axios.get('/api/setup/github/manifest', auth(idToken));
  const { action, manifest } = response.data;
  const form = document.createElement('form');
  form.method = 'post';
  form.action = action;
  const input = document.createElement('input');
  input.type = 'hidden';
  input.name = 'manifest';
  input.value = manifest;
  form.appendChild(input);
  document.body.appendChild(form);
  form.submit();
};
