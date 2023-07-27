import { Context, Logger, Schema, Session, sleep, randomId } from 'koishi'
import * as Matrix from '@koishijs/plugin-adapter-matrix'
import imageSize from 'image-size'
import { UserMatrixBot } from './bot'

declare module 'koishi' {
  interface Channel {
    matrixport_to: MatrixPortTo
    matrixport_from: MatrixPortFrom
    matrixport_userlist: string[]
  }

  interface User {
    matrixport: MatrixPortUser
  }
}

interface MatrixPortTo {
  roomId: string
  lastUpdated: number
}

interface MatrixPortFrom {
  assignee: string
  channelId: string
  guildId: string
}

interface MatrixPortUser {
  userId: string
  token: string
  lastUpdated: number
}

interface Config {
  space: string
  user: string
  bot: string
  prefix: string
  updateTime: number
}

export const Config: Schema<Config> = Schema.object({
  space: Schema.string().description('机器人新建房间时将会把房间移动至此空间。').required(),
  user: Schema.string().description('用户在 Matrix 的 id, 将会邀请用户至房间。').required(),
  bot: Schema.string().description('Matrix 机器人的 sid, 若未设置将会选择第一个 Matrix 机器人。'),
  prefix: Schema.string().description('matrix-port 会为转发用户新建一个 Matrix 用户，用于转发消息时携带头像、昵称等信息，此选项为用户 localpart 前缀。').required(),
  updateTime: Schema.number().description('将会以一定周期更新昵称、头像等信息。(ms)').default(1000 * 60 * 60 * 24),
})

export const name = 'matrix-port'

const logger = new Logger('matrix-logger')

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('channel', {
    matrixport_to: 'json',
    matrixport_from: 'json',
    matrixport_userlist: 'list',
  })
  ctx.model.extend('user', {
    matrixport: 'json',
  })
  ctx.on('ready', () => ready(ctx, config))
}

export async function ready(ctx: Context, config: Config) {
  const bot = (config.bot ? ctx.bots[config.bot] : ctx.bots.find(bot => bot.platform === 'matrix')) as Matrix.MatrixBot
  if (!bot) {
    throw new Error('未能找到可用的 Matrix 机器人。')
  }
  while (bot.status !== 'online') {
    await sleep(1000)
  }
  const rooms = Object.keys((await bot.syncRooms()).rooms.join || {})
  if (!rooms.includes(config.space)) {
    throw new Error('空间不存在。')
  }
  ctx.before('attach-channel', (_, fields) => {
    fields.add('matrixport_to')
    fields.add('matrixport_from')
    fields.add('matrixport_userlist')
  })
  ctx.before('attach-user', (_, fields) => fields.add('matrixport'))
  // the world
  const [lock, wait] = locker()
  ctx.middleware((_, next) => wait().then(next), true)
  ctx.middleware(async (session: Session<'matrixport', 'matrixport_from' | 'matrixport_to' | 'matrixport_userlist'>, next) => {
    if (session.bot === bot) {
      // ignore user bots
      if (session.userId !== config.user) return next()
      if (!session.channel.matrixport_from.channelId) return next()
      const { assignee, channelId, guildId } = session.channel.matrixport_from
      try {
        await ctx.bots[assignee].sendMessage(channelId, session.elements, guildId)
      } catch (e) {
        console.log(e)
        throw e
      } finally {
        return next()
      }
    }
    const unlock = await lock()
    try {
      if (!session.channel.matrixport_to.roomId) {
        const roomId = await createRoom(ctx, bot, config, session)
        await ctx.database.createChannel('matrix', roomId, {
          guildId: config.space,
          assignee: bot.userId,
          matrixport_from: {
            assignee: session.sid,
            channelId: session.channelId,
            guildId: session.guildId,
          },
        })
        session.channel.matrixport_to = {
          roomId,
          lastUpdated: +new Date(),
        }
      }
      if (!session.channel.matrixport_userlist.includes(session.uid)) {
        if (!session.user.matrixport.token) {
          await createUser(ctx, bot, config, session)
        }
        const { userId, token } = session.user.matrixport
        const { roomId } = session.channel.matrixport_to
        const userbot = new UserMatrixBot(ctx, bot, token)
        await bot.internal.invite(roomId, userId)
        await userbot.internal.joinRoom(roomId)
        session.channel.matrixport_userlist.push(session.uid)
      }
      if (+new Date() - session.channel.matrixport_to.lastUpdated > config.updateTime) {
        await updateRoom(ctx, session, bot)
      }
      if (+new Date() - session.user.matrixport.lastUpdated > config.updateTime) {
        await updateUser(ctx, session, bot)
      }
    } catch (e) {
      console.log(e)
      throw e
    } finally {
      unlock()
    }
    try {
      const userbot = new UserMatrixBot(ctx, bot, session.user.matrixport.token)
      await userbot.sendMessage(session.channel.matrixport_to.roomId, session.elements)
    } catch (e) {
      console.log(e)
      throw e
    } finally {
      return next()
    }
  })
  logger.info('matrix-port started')
  // TODO: deleteMessage
}

function locker(): [lock: () => Promise<() => void>, wait: () => Promise<void>] {
  let lock: Promise<void>
  return [async () => {
    await lock
    let resolve: () => void
    lock = new Promise(res => resolve = res)
    return () => {
      lock = null
      resolve()
    }
  }, () => lock || Promise.resolve()]
}

async function createRoom(
  ctx: Context,
  bot: Matrix.MatrixBot,
  config: Config,
  session: Session,
) {
  let name = session.channelName
  let avatar: string
  if (session.bot.getChannel) {
    const channel = await session.bot.getChannel(session.channelId, session.guildId)
    name ||= channel.channelName
    avatar = channel['avatar']
  }
  const roomId = await bot.internal.createRoom({
    name: name ? `${name} (${session.channelId})` : session.channelId,
    preset: 'private_chat',
    invite: [config.user],
    creation_content: {
      "m.federate": false,
    },
    initial_state: [{
      type: 'm.room.power_levels',
      content: {
        users: {
          [bot.userId]: 100,
          [config.user]: 100,
        },
      } satisfies Matrix.M_ROOM_POWER_LEVELS,
    }],
  })
  if (avatar) {
    const { data, mime } = await ctx.http.file(avatar)
    await setRoomAvatar(bot, roomId, Buffer.from(data), mime)
  }
  await bot.internal.setState(config.space, 'm.space.child', {
    suggested: false,
    via: [bot.config.host],
  } satisfies Matrix.M_SPACE_CHILD, roomId)
  await bot.syncRooms()
  return roomId
}

async function createUser(
  ctx: Context,
  bot: Matrix.MatrixBot,
  config: Config,
  session: Session<'matrixport'>,
) {
  const id = `${config.prefix}${randomId()}${randomId()}`
  const userId = `@${id}:${bot.config.host}`
  const user = await bot.internal.register(id, bot.config.asToken)
  session.user.matrixport = {
    userId,
    token: user.access_token,
    lastUpdated: +new Date()
  }
  await updateUser(ctx, session, bot)
}

async function updateUser(
  ctx: Context,
  session: Session<'matrixport'>,
  bot: Matrix.MatrixBot,
) {
  const { userId, token } = session.user.matrixport
  let nickname = session.author.nickname
  let avatar = session.author.avatar
  if ((!avatar || !nickname) && session.bot.getUser) {
    const user = await session.bot.getUser(session.userId, session.guildId)
    avatar ||= user.avatar
    nickname ||= user.nickname
  }
  const userbot = new UserMatrixBot(ctx, bot, token)
  if (avatar) {
    const { data, mime } = await ctx.http.file(avatar)
    await userbot.internal.setAvatar(userId, Buffer.from(data), mime)
  }
  if (nickname) {
    await userbot.internal.setDisplayName(userId, `${nickname} (${session.userId})`)
  } else {
    await userbot.internal.setDisplayName(userId, session.userId)
  }
  session.user.matrixport.lastUpdated = +new Date()
}

async function updateRoom(
  ctx: Context,
  session: Session<never, 'matrixport_to'>,
  bot: Matrix.MatrixBot,
) {
  const roomId = session.channel.matrixport_to.roomId
  let channelName = session.channelName
  let avatar: string
  if (session.bot.getChannel) {
    const channel = await session.bot.getChannel(session.channelId, session.guildId)
    channelName ||= channel.channelName
    //                            TODO: remove this
    avatar = channel['avatar'] || channel['__CHRONO_UNSAFE_AVATAR__']
  }
  if (avatar) {
    const { data, mime } = await ctx.http.file(avatar)
    await setRoomAvatar(bot, roomId, Buffer.from(data), mime)
  }
  let name = channelName ? `${channelName} (${session.channelId})` : session.channelId
  const nameState = (await bot.internal.getState(roomId)).find(state => state.type === 'm.room.name')
  if ((nameState.content as Matrix.M_ROOM_NAME).name !== name) {
    await bot.internal.setState(roomId, 'm.room.name', {
      name,
    } satisfies Matrix.M_ROOM_NAME)
  }
  session.channel.matrixport_to.lastUpdated = +new Date()
}

async function setRoomAvatar(
  bot: Matrix.MatrixBot,
  roomId: string,
  avatar: Buffer,
  mimetype: string,
) {
  const url = await bot.internal.uploadFile('avatar', avatar, mimetype)
  const { width, height } = imageSize(avatar)
  await bot.internal.setState(roomId, 'm.room.avatar', {
    url,
    info: {
      size: avatar.byteLength,
      w: width, h: height,
      mimetype,
    },
  } satisfies Matrix.M_ROOM_AVATAR)
}
