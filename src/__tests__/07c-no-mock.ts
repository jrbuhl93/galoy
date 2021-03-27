/**
 * @jest-environment node
 */
import { setupMongoConnection } from "../mongodb";
import { getTokenFromPhoneIndex } from "../walletFactory";
import mongoose from "mongoose";

jest.mock('../realtimePrice')

let uid

beforeAll(async () => {
  await setupMongoConnection();
  ({ uid } = await getTokenFromPhoneIndex(7))
})

afterAll(async () => {
  await mongoose.connection.close()
})

// to not have jest failing because there is no test in the file
it('test', () => expect(true).toBeTruthy())


// it('getExchangeBalance', async () => {
//   ({ uid } = await getTokenFromPhoneIndex(7))
//   const wallet = new DealerWallet({ uid, logger: baseLogger })
//   const balance = await wallet.getExchangeBalance()
//   console.log({balance})
// })

// it('getFunding', async () => {
//   const dealerWalletNofixtures = new DealerWallet({ uid, logger: baseLogger })
//   console.log(await dealerWalletNofixtures.getNextFundingRate())
// })

// it('private Account', async () => {
//   const dealer = new DealerWallet({ uid, logger: baseLogger })
//   await dealer.getAccountPosition()
// })
