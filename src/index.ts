import dotenv from "dotenv";
import { rule, shield } from 'graphql-shield';
import { GraphQLServer } from 'graphql-yoga';
import * as jwt from 'jsonwebtoken';
import moment from "moment";
import { AdminWallet } from "./AdminWallet";
import { DbVersion, setupMongoConnection, User } from "./mongodb";
import { sendNotification } from "./notification";
import { Price } from "./priceImpl";
import { login, requestPhoneCode } from "./text";
import { OnboardingEarn } from "./types";
import { baseLogger, customLoggerPrefix, getAuth, nodeStats } from "./utils";
import { WalletFactory, WalletFromUsername } from "./walletFactory";
import { UserWallet } from "./wallet"
import { v4 as uuidv4 } from 'uuid';
import { startsWith } from "lodash";
import { upgrade } from "./upgrade"
const util = require('util')
const lnService = require('ln-service')


const path = require("path");
dotenv.config()

const graphqlLogger = baseLogger.child({ module: "graphql" })
const pino = require('pino')

const pino_http = require('pino-http')({
  logger: graphqlLogger,
  wrapSerializers: false,

  // Define custom serializers
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: (res) => ({
      // FIXME: kind of a hack. body should be in in req. but have not being able to do it.
      body: res.req.body,
      ...pino.stdSerializers.res(res)
    })
  },
  reqCustomProps: function(req) {
    return {
      // FIXME: duplicate parsing from graphql context.
      token: verifyToken(req)
    }
  },
  autoLogging: {
    ignorePaths: ["/healthz"]
  }
})

const { lnd } = lnService.authenticatedLndGrpc(getAuth())

const commitHash = process.env.COMMITHASH
const buildTime = process.env.BUILDTIME
const helmRevision = process.env.HELMREVISION

// TODO: caching for some period of time. maybe 1h
const getMinBuildNumber = async () => {
  const { minBuildNumber, lastBuildNumber } = await DbVersion.findOne({}, { minBuildNumber: 1, lastBuildNumber: 1, _id: 0 })
  return { minBuildNumber, lastBuildNumber }
}

const resolvers = {
  Query: {
    me: async (_, __, { uid }) => {
      const { phone, username } = await User.findOne({ _id: uid })

      return {
        id: uid,
        level: 1,
        phone,
        username,
      }
    },
    wallet: async (_, __, { wallet }) => ([{
      id: wallet.currency,
      currency: wallet.currency,
      balance: () => wallet.getBalance(),
      transactions: () => wallet.getTransactions(),
      csv: () => wallet.getStringCsv()
    }]),
    nodeStats: async () => nodeStats({lnd}),
    buildParameters: async () => {
      const { minBuildNumber, lastBuildNumber } = await getMinBuildNumber()

      return {
        id: lastBuildNumber,
        commitHash: () => commitHash,
        buildTime: () => buildTime,
        helmRevision: () => helmRevision,
        minBuildNumberAndroid: minBuildNumber,
        minBuildNumberIos: minBuildNumber,
        lastBuildNumberAndroid: lastBuildNumber,
        lastBuildNumberIos: lastBuildNumber,
    }},
    prices: async (_, __, {logger}) => {
      const price = new Price({logger})
      return await price.lastCached()
    },
    earnList: async (_, __, { uid }) => {
      const response: Object[] = []

      const user = await User.findOne({ _id: uid })
      const earned = user?.earn || []

      for (const [id, value] of Object.entries(OnboardingEarn)) {
        response.push({
          id,
          value,
          completed: earned.findIndex(item => item === id) !== -1,
        })
      }

      return response
    },
    getLastOnChainAddress: async (_, __, { wallet }) => ({ id: wallet.getLastOnChainAddress() }),

    // TODO: make this dynamic with call from MongoDB
    maps: async () => [
      {
        id: 1,
        title: "Bitcoin ATM - Café Cocoa",
        coordinate: {
          latitude: 13.496743,
          longitude: -89.439462,
        },
      },
    ],
    usernameExists: async (_, { username }, { wallet }) => await UserWallet.usernameExists({ username })

  },
  Mutation: {
    requestPhoneCode: async (_, { phone }, { logger }) => ({ success: requestPhoneCode({ phone, logger }) }),
    login: async (_, { phone, code, currency }, { logger }) => ({ token: login({ phone, code, currency, logger }) }),
    updateUser: async (_, __, { wallet }) => ({
      // FIXME manage uid
      // TODO only level for now
      setLevel: async () => {
        const result = await wallet.setLevel({ level: 1 })
        return {
          id: wallet.uid,
          level: result.level,
        }
      },
      setUsername: async ({ username }) => await wallet.setUsername({ username })

    }),
    publicInvoice: async (_, { username }, { logger }) => {
      const wallet = await WalletFromUsername({ username, logger })
      return {
        addInvoice: async ({ value, memo }) => wallet.addInvoice({ value, memo, selfGenerated: false }),
        updatePendingInvoice: async ({ hash }) => wallet.updatePendingInvoice({ hash })
      }
    },
    invoice: async (_, __, { wallet }) => ({
      addInvoice: async ({ value, memo }) => wallet.addInvoice({ value, memo }),
      updatePendingInvoice: async ({ hash }) => wallet.updatePendingInvoice({ hash }),
      payInvoice: async ({ invoice, amount, memo }) => wallet.pay({ invoice, amount, memo })
    }),
    earnCompleted: async (_, { ids }, { wallet }) => wallet.addEarn(ids),
    deleteUser: () => {
      // TODO
    },
    onchain: async (_, __, { wallet }) => ({
      getNewAddress: () => wallet.getOnChainAddress(),
      pay: ({ address, amount, memo }) => ({ success: wallet.onChainPay({ address, amount, memo }) }),
      getFee: ({ address }) => wallet.getOnchainFee({ address }),
    }),
    addDeviceToken: async (_, { deviceToken }, { uid }) => {
      // TODO: refactor to a higher level User class
      const user = await User.findOne({ _id: uid })
      user.deviceToken.addToSet(deviceToken)
      await user.save()
      return { success: true }
    },

    // FIXME test
    testMessage: async (_, __, { uid, logger }) => {
      // throw new LoggedError("test error")
      await sendNotification({
        uid,
        title: "Title",
        body: `New message sent at ${moment.utc().format('YYYY-MM-DD HH:mm:ss')}`,
        logger
      })
      return { success: true }
    },
  }
}


function verifyToken(req) {

  let token
  try {
    const auth = req.get('Authorization')

    if (!auth) {
      return null
    }

    if (auth.split(" ")[0] !== "Bearer") {
      throw Error("not a bearer token")
    }

    const raw_token = auth.split(" ")[1]
    token = jwt.verify(raw_token, process.env.JWT_SECRET);

    // TODO assert bitcoin network
  } catch (err) {
    return null
    // TODO return new AuthenticationError("Not authorised"); ?
    // ie: differenciate between non authenticated, and not authorized
  }
  return token
}

const isAuthenticated = rule({ cache: 'contextual' })(
  async (parent, args, ctx, info) => {
    return ctx.uid !== null
  },
)

const permissions = shield({
  Query: {
    // prices: not(isAuthenticated),
    // earnList: isAuthenticated,
    wallet: isAuthenticated,
    me: isAuthenticated,
  },
  Mutation: {
    // requestPhoneCode: not(isAuthenticated),
    // login: not(isAuthenticated),

    openChannel: isAuthenticated, // FIXME: this should be isAuthenticated && isAdmin

    onchain: isAuthenticated,
    invoice: isAuthenticated,
    earnCompleted: isAuthenticated,
    updateUser: isAuthenticated,
    deleteUser: isAuthenticated,
    addDeviceToken: isAuthenticated,
  },
}, { allowExternalErrors: true }) // TODO remove to not expose internal error


const server = new GraphQLServer({
  typeDefs: path.join(__dirname, "schema.graphql"),
  resolvers,
  middlewares: [permissions],
  context: async (context) => {
    const token = verifyToken(context.request)
    const uid = token?.uid ?? null
    // @ts-ignore
    const logger = graphqlLogger.child({ token, id: context.request.id, body: context.request.body })
    const wallet = !!token ? WalletFactory({ ...token, logger }) : null
    return {
      ...context,
      logger,
      uid,
      wallet,
    }
  }
})

// injecting unique id to the request for correlating different logs messages
server.express.use(function(req, res, next) {
  // @ts-ignore
  req.id = uuidv4();
  next();
});

server.express.use(pino_http)


// Health check
server.express.get('/healthz', function(req, res) {
  res.send('OK');
});

const options = {
  // tracing: true,
  formatError: err => {
    // FIXME
    if (startsWith(err.message, customLoggerPrefix)) {
      err.message = err.message.slice(customLoggerPrefix.length)
    } else {
      baseLogger.error({err}, "graphql catch-all error"); 
    }
    // return defaultErrorFormatter(err)
    return err
  },
  endpoint: '/graphql',
  playground: process.env.NETWORK === 'mainnet' ? 'false' : '/'
}

setupMongoConnection()
  .then(() => {
    upgrade().then(() => {
      server.start(options, ({ port }) =>
        graphqlLogger.info(
          `Server started, listening on port ${port} for incoming requests.`,
        ),
      )
    })
  }).catch((err) => graphqlLogger.error(err, "server error"))

