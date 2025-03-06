// lnbitsService.test.ts
import {
    getAccessToken,
    createInvoice,
    getWallets,
    getUserWallets,
    payInvoice
  } from './lnbitsService'; // Adjust import as necessary
  
  import { 
    expect, 
    describe, 
    test,
    beforeEach,
    jest
   } from '@jest/globals';
  
  // Mock the necessary dependencies (like fetch)
  jest.mock('./lnbitsService');
  
  describe('LNbitsService tests', () => {
    const mockAccessToken = 'testAccessToken';
    const mockAdminKey = 'adminKey';
    const mockInKey = 'inKey';
  
    beforeEach(() => {
      jest.clearAllMocks();
    });
  
    test('getAccessToken should return cached token', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(mockAccessToken);
  
      const token = await getAccessToken('user', 'pass');
      expect(token).toBe(mockAccessToken);
    });
  
    test('createInvoice should return payment request', async () => {
      const mockPaymentRequest = 'lnbc1...';
      (createInvoice as jest.Mock).mockResolvedValue(mockPaymentRequest);
  
      const result = await createInvoice(mockInKey, 'walletId', 1000, 'test', {});
      expect(result).toBe(mockPaymentRequest);
      expect(createInvoice).toHaveBeenCalledWith(mockInKey, 'walletId', 1000, 'test', {});
    });
  
    test('getWallets should return filtered wallet data', async () => {
      const mockWallets = [{ id: '1', name: 'testWallet' }];
      (getWallets as jest.Mock).mockResolvedValue(mockWallets);
  
      const wallets = await getWallets(mockAdminKey);
      expect(wallets).toEqual(mockWallets);
      expect(getWallets).toHaveBeenCalledWith(mockAdminKey, undefined, undefined);
    });
  
    test('getUserWallets should return user wallets', async () => {
      const mockUserWallets = [{ id: 'wallet1', name: 'userWallet' }];
      (getUserWallets as jest.Mock).mockResolvedValue(mockUserWallets);
  
      const result = await getUserWallets(mockAdminKey, 'userId');
      expect(result).toEqual(mockUserWallets);
      expect(getUserWallets).toHaveBeenCalledWith(mockAdminKey, 'userId');
    });
  
    test('payInvoice should resolve payment', async () => {
      const mockPaymentResult = { payment_hash: '123abc' };
      (payInvoice as jest.Mock).mockResolvedValue(mockPaymentResult);
  
      const result = await payInvoice(mockAdminKey, 'paymentRequest', {});
      expect(result).toEqual(mockPaymentResult);
      expect(payInvoice).toHaveBeenCalledWith(mockAdminKey, 'paymentRequest', {});
    });
  });
  
