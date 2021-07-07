import axios from "axios"
import moment from "moment"
import twilio from "twilio"
import { yamlConfig } from "./config"
import { IPBlacklistedError, TooManyRequestError } from "./error"
import { createToken } from "./jwt"
import { baseLogger } from "./logger"
import {
  failedAttemptPerIp,
  limiterLoginAttempt,
  limiterRequestPhoneCode,
  limiterRequestPhoneCodeIp,
} from "./rateLimit"
import { PhoneCode, User } from "./schema"
import {
  fetchIP,
  isIPBlacklisted,
  isIPTypeBlacklisted,
  randomIntFromInterval,
} from "./utils"
import { Logger } from "./types"

// const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER
const twilioPhoneNumber = "+15005550006"
const getTwilioClient = () => {
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const apiKey = process.env.TWILIO_API_KEY
  const apiSecret = process.env.TWILIO_API_SECRET

  const testAccountSid = ""
  const testAuthToken = ""

  // const client = twilio(apiKey, apiSecret, { accountSid })
  const client = twilio(testAccountSid, testAuthToken)
  return client
}

interface OSendTwilioText {
  success: boolean
  sid: string,
  status: string
}

export const sendTwilioText = async ({ body, to, logger }): Promise<OSendTwilioText> => {
  let twilioStatusCallbackUri

  const port = process.env.PORT || 3000
  if (process.env.NETWORK === "MAINNET") {
    twilioStatusCallbackUri = `https://twilio.mainnet.galoy.io:${port}/twilioMessageStatus`
  } else if (process.env.NETWORK === "TESTNET") {
    twilioStatusCallbackUri = `https://twilio.testnet.galoy.io/${port}/twilioMessageStatus`
  } else if (process.env.NETWORK === "REGTEST") {
    twilioStatusCallbackUri = `http://localhost:${port}/twilioMessageStatus`
  }

  const provider = "twilio"
  let sid
  let status
  try {
    const response = await getTwilioClient().messages.create({
      from: twilioPhoneNumber,
      to,
      body,
      statusCallback: twilioStatusCallbackUri,
    })

    sid = response.sid
    status = response.status
  } catch (err) {
    logger.error({ err, provider }, "impossible to send text")
    return { success: false, sid: "", status: "" }
  }

  logger.info({ to, provider }, "sent text successfully")
  return { success: true, sid, status }
}

export const sendSMSalaText = async ({ body, to, logger }) => {
  const provider = "smsala"
  try {
    const base_url = "http://api.smsala.com/api/SendSMS"
    const api_id = process.env.SMSALA_API_ID
    const api_password = process.env.SMSALA_API_PASSWORD
    const sms_type = "T"
    const encoding = "T"
    const sender_id = process.env.SMSALA_SENDER_ID
    // SMSala api does not acccept nonnumeric characters like '+'
    const phoneNumber = to.replace(/\D/g, "")

    let url = `${base_url}?api_id=${api_id}&api_password=${api_password}`
    url = url + `&sms_type=${sms_type}&encoding=${encoding}&sender_id=${sender_id}`
    url = url + `&phonenumber=${phoneNumber}&textmessage=${body}`
    await axios.get(url)
  } catch (err) {
    logger.error({ err, provider }, "impossible to send text")
    return
  }

  logger.info({ to, provider }, "sent text successfully")
}

export const getCarrier = async (phone: string) => {
  const result = await getTwilioClient()
    .lookups.phoneNumbers(phone)
    .fetch({ type: ["carrier"] })
  baseLogger.info({ result }, "result carrier info")
  return result
}

export const requestPhoneCode = async ({
  phone,
  logger,
  ip,
}: {
  phone: string
  logger: Logger
  ip: string
}): Promise<boolean> => {
  logger.info({ phone, ip }, "RequestPhoneCode called")

  if (isIPBlacklisted({ ip })) {
    throw new IPBlacklistedError("IP Blacklisted", { logger, ip })
  }

  let ipDetails

  try {
    ipDetails = await fetchIP({ ip })
  } catch (err) {
    logger.warn({ err }, "Unable to fetch ip details")
  }

  if (!ipDetails || ipDetails.status === "denied" || ipDetails.status === "error") {
    logger.warn({ ipDetails }, "Unable to fetch ip details")
  }

  if (isIPTypeBlacklisted({ type: ipDetails?.type })) {
    throw new IPBlacklistedError("IP type Blacklisted", { logger, ipDetails })
  }

  try {
    await limiterRequestPhoneCode.consume(phone)
  } catch (err) {
    if (err instanceof Error) {
      throw err
    } else {
      throw new TooManyRequestError({ logger })
    }
  }

  try {
    await limiterRequestPhoneCodeIp.consume(ip)
  } catch (err) {
    if (err instanceof Error) {
      throw err
    } else {
      throw new TooManyRequestError({ logger })
    }
  }

  // make it possible to bypass the auth for testing purpose
  if (yamlConfig.test_accounts.findIndex((item) => item.phone === phone) !== -1) {
    return true
  }

  const code = randomIntFromInterval(100000, 999999)
  const body = `${code} is your verification code for ${yamlConfig.name}`
  const sms_provider = yamlConfig.sms_provider.toLowerCase()

  try {
    const veryRecentCode = await PhoneCode.findOne({
      phone,
      created_at: {
        $gte: moment().subtract(30, "seconds"),
      },
    })

    if (veryRecentCode) {
      return false
    }

    await PhoneCode.create({ phone, code, sms_provider })

    const sendTextArguments = { body, to: phone, logger }
    if (sms_provider === "twilio") {
      const oSendTwilioText = await sendTwilioText(sendTextArguments)
      if (oSendTwilioText.success) {
        await PhoneCode.findOneAndUpdate(
          { phone, code },
          { 
            twilioMessageSid: oSendTwilioText.sid,
            twilioMessageStatus: oSendTwilioText.status
          }
        )
      }
    } else if (sms_provider === "smsala") {
      await sendSMSalaText(sendTextArguments)
    } else {
      // sms provider in yaml did not match any sms implementation
      return false
    }
  } catch (err) {
    logger.error({ err }, "impossible to send message")
    return false
  }

  return true
}

interface IRecordMessageStatus {
  twilioMessageSid: string,
  twilioMessageStatus: string,
}

export const recordMessageStatus = async ({
  twilioMessageSid,
  twilioMessageStatus
}: IRecordMessageStatus) => {
  await PhoneCode.findOneAndUpdate({ twilioMessageSid }, { twilioMessageStatus })
}

interface ILogin {
  phone: string
  code: number
  logger: Logger
  ip: string
}

export const login = async ({
  phone,
  code,
  logger,
  ip,
}: ILogin): Promise<string | null> => {
  const subLogger = logger.child({ topic: "login" })

  const rlResult = await failedAttemptPerIp.get(ip)
  if (
    rlResult !== null &&
    rlResult.consumedPoints > yamlConfig.limits.failedAttemptPerIp.points
  ) {
    throw new TooManyRequestError({ logger })
  }

  try {
    await limiterLoginAttempt.consume(phone)
  } catch (err) {
    if (err instanceof Error) {
      throw err
    } else {
      throw new TooManyRequestError({ logger })
    }
  }

  try {
    const codes = await PhoneCode.find({
      phone,
      created_at: {
        $gte: moment().subtract(20, "minutes"),
      },
    })

    // is it a test account?
    if (
      yamlConfig.test_accounts.findIndex((item) => item.phone === phone) !== -1 &&
      yamlConfig.test_accounts.filter((item) => item.phone === phone)[0].code === code
    ) {
      // we are in this branch if phone is a test account + code is correct
    } else if (codes.findIndex((item) => item.code === code) === -1) {
      // this branch is both relevant for test and non-test accounts
      // for when the code is not correct
      subLogger.warn({ phone, code }, `user enter incorrect code`)

      try {
        await failedAttemptPerIp.consume(ip)
      } catch (err) {
        logger.error({ ip }, "impossible to consume failedAttemptPerIp")
      }

      return null
    }

    // code is correct

    // reseting the limiter for this phone
    limiterLoginAttempt.delete(phone) // no need to await the promise

    // rewarding the ip address at the request code level
    limiterRequestPhoneCodeIp.reward(ip)

    // get User
    let user

    user = await User.findOne({ phone })

    if (user) {
      subLogger.info({ phone }, "user logged in")
    } else {
      user = await User.findOneAndUpdate({ phone }, {}, { upsert: true, new: true })
      subLogger.info({ phone }, "a new user has register")
    }

    // TODO
    // if (yamlConfig.carrierRegexFilter)  {
    //
    // }

    // only fetch info once
    if (user.twilio.countryCode === undefined || user.twilio.countryCode === null) {
      try {
        const result = await getCarrier(phone)
        user.twilio = result
        await user.save()
      } catch (err) {
        // Carrier fetching is a non-critical operation
        // Primarily useful for analytics
        // Hence failure should be handled with a warn instead of an error
        subLogger.warn({ err }, "impossible to fetch carrier")
      }
    }

    const network = process.env.NETWORK
    return createToken({ uid: user._id, network })
  } catch (err) {
    subLogger.error({ err }, "login issue")
    throw err
  }
}
