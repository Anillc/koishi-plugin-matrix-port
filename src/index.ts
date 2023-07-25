import { Context, Logger, Schema } from 'koishi'
import * as Matrix from '@koishijs/plugin-adapter-matrix'

interface Config {
  space: string
  source: string
  user: string
  bot: string
}

export const Config: Schema<Config> = Schema.object({
  space: Schema.string().description('机器人新建房间时将会把房间移动至此空间').required(),
  source: Schema.string().description('源 bot 的 cid, 将会从此 bot 转发消息至 Matrix。').required(),
  user: Schema.string().description('用户在 Matrix 的 id, 将会邀请用户至房间。').required(),
  bot: Schema.string().description('Matrix 机器人的 cid, 若未设置将会选择第一个 Matrix 机器人。'),
})

export const name = 'matrix-port'

const logger = new Logger('matrix-logger')

export function apply(ctx: Context, config: Config) {
  ctx.on('ready', () => ready(ctx, config))
}

export async function ready(ctx: Context, config: Config) {
  const bot = (config.bot ? ctx.bots[config.bot] : ctx.bots.find(bot => bot.platform === 'matrix')) as Matrix.MatrixBot
  if (!bot) {
    logger.error('未能找到可用的 Matrix 机器人。')
    return
  }
  const source = ctx.bots[config.source]
}
