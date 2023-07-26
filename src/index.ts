import { Context, Logger, Schema, Session, sleep } from 'koishi'
import * as Matrix from '@koishijs/plugin-adapter-matrix'

declare module 'koishi' {
  interface Channel {
    matrixport_to: MatrixPortTo
    matrixport_from: MatrixPortFrom
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

interface Config {
  space: string
  user: string
  bot: string
}

export const Config: Schema<Config> = Schema.object({
  space: Schema.string().description('机器人新建房间时将会把房间移动至此空间。').required(),
  user: Schema.string().description('用户在 Matrix 的 id, 将会邀请用户至房间。').required(),
  bot: Schema.string().description('Matrix 机器人的 sid, 若未设置将会选择第一个 Matrix 机器人。'),
})

export const name = 'matrix-port'

const logger = new Logger('matrix-logger')

export function apply(ctx: Context, config: Config) {
  ctx.model.extend('channel', {
    matrixport_to: 'json',
    matrixport_from: 'json',
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
  })
  // the world
  const [lock, wait] = locker()
  ctx.middleware((_, next) => wait().then(next), true)
  ctx.middleware(async (session: Session<never, 'matrixport_from' | 'matrixport_to'>, next) => {
    if (session.bot === bot) {
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
    if (!session.channel.matrixport_to.roomId) {
      const unlock = await lock()
      try {
        let name = session.channelName
        if (!name && session.bot.getChannel) {
          const channel = await session.bot.getChannel(session.channelId, session.guildId)
          name = channel.channelName
        }
        const roomId = await bot.internal.createRoom({
          name: name ? `${name} (${session.channelId})` : session.channelId,
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
        await bot.internal.setState(config.space, 'm.space.child', {
          suggested: false,
          via: [bot.config.host],
        } satisfies Matrix.M_SPACE_CHILD, roomId)
        await bot.syncRooms()
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
      } catch (e) {
        console.log(e)
        throw e
      }finally {
        unlock()
        return next()
      }
    }
    try {
      await bot.sendMessage(session.channel.matrixport_to.roomId, session.elements)
    } catch (e) {
      console.log(e)
      throw e
    } finally {
      return next()
    }
  })
  logger.info('matrix-port started')
  // TODO: deleteMessage
  // TODO: create user
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
