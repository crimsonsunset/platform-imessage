import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

/**
 * Kill any `tail -f` processes targeting Beeper log files opened by `yarn deploy`.
 * Matches both platform-imessage.log and platform_worker logs.
 */
async function main(): Promise<void> {
  console.log('\n🔪  Killing deploy log tails...\n')

  try {
    await execAsync('pkill -f "tail -f.*BeeperTexts/logs"')
    console.log('✅  Log tail processes killed.\n')
  } catch {
    console.log('ℹ️   No log tail processes were running.\n')
  }
}

main().catch(err => {
  console.error('\n❌ Kill failed:', err)
  process.exit(1)
})
