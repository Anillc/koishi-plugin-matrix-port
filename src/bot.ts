import MatrixBot, { Internal, MatrixMessageEncoder } from '@koishijs/plugin-adapter-matrix'
import { Context, Fragment, Quester, SendOptions, Session, Universal } from 'koishi'

export class UserMatrixBot {
  http: Quester
  internal: Internal
  constructor(
    public ctx: Context,
    public matrix: MatrixBot,
    public token: string,
  ) {
    const endpoint = (matrix.config.endpoint || `https://${matrix.config.host}`) + '/_matrix'
    this.http = ctx.http.extend({
      endpoint,
      headers: {
        'Authorization': `Bearer ${token}`,
      },
    })
    this.internal = new Internal(this as any)
  }

  session(payload?: Partial<Session.Payload>) {
    return new Session(this as any, payload)
  }

  async sendMessage(channelId: string, content: Fragment, guildId?: string, options?: SendOptions) {
    return new MatrixMessageEncoder(this as any, channelId, guildId, options).send(content)
  }

  async sendPrivateMessage(channelId: string, content: Fragment, options?: SendOptions) {
    return new MatrixMessageEncoder(this as any, channelId, null, options).send(content)
  }

  async getMessage(channelId: string, messageId: string): Promise<Universal.Message> {
    return await this.matrix.getMessage(channelId, messageId)
  }
}
