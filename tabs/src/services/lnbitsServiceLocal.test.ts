// lnbitsServiceLocal.test.ts
import {
  getAccessToken,
  getWallets,
  getWalletBalance,
  getUserWallets,
  createInvoice,
  payInvoice
} from './lnbitsServiceLocal'; // Adjust the path if necessary
import { 
  expect, 
  describe, 
  test,
  beforeEach,
  jest
 } from '@jest/globals';

 const mockFetch = global.fetch as jest.MockedFunction<typeof fetch>;

 describe('lnbitsServiceLocal Tests', () => {
   const mockAccessToken: string = 'mockedAccessToken'; // Explicit type
   const mockInKey: string = 'mockedInKey';
   const mockAdminKey: string = 'mockedAdminKey';
   const mockPaymentRequest: string = 'lnbc1...'; // Explicit type
   const mockPaymentResult: { payment_hash: string } = { payment_hash: '123abc' }; // Explicit type
   const mockWallets: { id: string; name: string }[] = [{ id: 'wallet1', name: 'testWallet' }]; // Explicit type
   const mockUserWallets: { id: string; name: string }[] = [{ id: 'wallet1', name: 'userWallet' }]; // Explicit type
 
   beforeEach(() => {
     jest.clearAllMocks();
     localStorage.setItem('accessToken', mockAccessToken);
   });
 
   test('getAccessToken should return the access token from localStorage', async () => {
     const token = await getAccessToken('user', 'password');
     expect(token).toBe(mockAccessToken);
     expect(fetch).not.toHaveBeenCalled(); // Should not make an API call if token is cached
   });
 
   test('getWallets should return a filtered list of wallets', async () => {
     mockFetch.mockResolvedValueOnce({
       ok: true,
       json: async () => mockWallets,
     } as Response);
 
     const result = await getWallets();
     expect(result).toEqual(mockWallets);
     expect(fetch).toHaveBeenCalledWith(expect.any(String), expect.any(Object));
   });
 
   test('getUserWallets should return user wallets', async () => {
     mockFetch.mockResolvedValueOnce({
       ok: true,
       json: async () => mockUserWallets,
     } as Response);
 
     const result = await getUserWallets(mockAdminKey, 'userId');
     expect(result).toEqual(mockUserWallets);
     expect(fetch).toHaveBeenCalled();
   });
 
   test('createInvoice should create an invoice and return the payment request', async () => {
     mockFetch.mockResolvedValueOnce({
       ok: true,
       json: async () => ({ payment_request: mockPaymentRequest }),
     } as Response);
 
     const paymentRequest = await createInvoice(mockInKey, 'walletId', 1000, 'test memo');
     expect(paymentRequest).toBe(mockPaymentRequest);
     expect(fetch).toHaveBeenCalled();
   });
 
   test('payInvoice should resolve the payment successfully', async () => {
     mockFetch.mockResolvedValueOnce({
       ok: true,
       json: async () => mockPaymentResult,
     } as Response);
 
     const result = await payInvoice(mockAdminKey, 'paymentRequest');
     expect(result).toEqual(mockPaymentResult);
     expect(fetch).toHaveBeenCalled();
   });
 });
  
