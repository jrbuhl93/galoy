import * as admin from 'firebase-admin';
import { User } from "./mongodb";
import { logger } from "./utils";
import { INotification } from "./types"

// the key GOOGLE_APPLICATION_CREDENTIALS should be set in production to the path of the credentials
// to use this class in a dev enviroment, set GOOGLE_APPLICATION_CREDENTIALS
// more info at https://firebase.google.com/docs/admin/setup
if(process.env.GOOGLE_APPLICATION_CREDENTIALS) { 
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  })
}

export const sendNotification = async ({uid, title, body, data}: INotification) => {

  const user = await User.findOne({ _id: uid })
  const message = {
    data,
    // fcmOptions: {}
    // apns: {}
    notification:{
      title,
      body
    },
    tokens: user.deviceToken
  }

  const response = await admin.messaging().sendMulticast(message)  
  logger.info(response.successCount + ' messages were sent successfully');

}