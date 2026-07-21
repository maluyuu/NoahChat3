import { readFile } from 'node:fs/promises'
import { Client, GatewayIntentBits } from 'discord.js'

const CHANNEL_ID = '1374631435637624892'
const TOKEN = process.env.DISCORD_TOKEN_NOAH
if (!TOKEN) throw new Error('DISCORD_TOKEN_NOAH is required')

async function main() {
  const state = JSON.parse(await readFile('/home/admin/.openclaw/workspace/data/monitor/catigoal_team_2496.json', 'utf8')) as {
    lastPublished?: string
    lastSeenAt?: string
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] })
  await client.login(TOKEN)
  const channel = await client.channels.fetch(CHANNEL_ID)
  if (!channel || !channel.isTextBased()) throw new Error('target channel not available')

  await channel.send([
    'CatiGoalの試合一覧が更新されたよ。',
    '推定: 新しい試合の追加、または試合情報の更新が入った可能性が高い。',
    `Last published: ${state.lastPublished ?? 'unknown'}`,
    '詳細は埋め込み一覧を見てね。',
  ].join('\n'))
  await client.destroy()
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
