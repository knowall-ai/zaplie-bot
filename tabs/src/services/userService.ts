// Methods concerning the logged in user/users

const getCurrentUser = async (): Promise<User | null> => {
  // TODO: Implement this Akash
  const user: User = {
    id: '8932744254ee408a8a2d198e69a5a714',
    displayName: 'Akash Jadhav (EvrosDemo)',
    profileImg:
      'https://hiberniaevros.sharepoint.com/_layouts/15/userphoto.aspx?AccountName=akash.jadhav@evrosdemo.onmicrosoft.com',
    aadObjectId: '4f882e7e-f30e-4fe2-8514-6d583f1efe5b',
    email: 'akash.jadhav@evrosdemo.onmicrosoft.com',
    privateWallet: null, // You get the idea
    allowanceWallet: null,
    type: 'Teammate',
  };
  return user;
};

const getAllUsers = async (): Promise<User[] | null> => {
  throw new Error('Not implemented');
};

const getFriends = async (): Promise<User[] | null> => {
  throw new Error('Not implemented');
};

export { getCurrentUser, getAllUsers, getFriends };
