import { exec } from 'child_process'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { fileURLToPath } from 'url'
import { shellExec } from '../src/util.js'
import { patchBundles } from './patch-bundles.js'

const execAsync = promisify(exec)

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const BEEPER_APP = '/Applications/Beeper Desktop.app'
const BEEPER_BINARY_DEST = `${BEEPER_APP}/Contents/Resources/app/build/platform-imessage/darwin-arm64/SwiftServer.node`
const LOG_BASE = path.join(os.homedir(), 'Library/Application Support/BeeperTexts/logs')

// ---------------------------------------------------------------------------
// Terminal helpers (Cursor-specific, ported from sync2hire terminal.helpers.ts)
// ---------------------------------------------------------------------------

/** Escape a string for use inside AppleScript double-quoted strings. */
function escapeForAppleScript(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/** Run an osascript snippet. */
async function runOsascript(script: string): Promise<void> {
  const escaped = script.replace(/'/g, "'\"'\"'")
  await execAsync(`osascript -e '${escaped}'`, { maxBuffer: 10 * 1024 })
}

/**
 * Open a new Cursor terminal tab and run the given shell command in it.
 */
async function openCursorTab(cmd: string): Promise<void> {
  const script = `
    tell application "Cursor" to activate
    delay 0.3
    tell application "System Events"
      tell process "Cursor"
        click menu item "New Terminal" of menu "Terminal" of menu bar 1
      end tell
    end tell
    delay 0.6
    tell application "System Events" to keystroke "${escapeForAppleScript(cmd)}" & return
  `
  await runOsascript(script)
}

// ---------------------------------------------------------------------------
// Beeper lifecycle
// ---------------------------------------------------------------------------

/** Poll :23373 until Beeper's MCP server accepts connections. */
async function waitForMcp(timeoutMs = 30_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>(resolve => {
      const req = http.request(
        { hostname: 'localhost', port: 23373, path: '/v0/mcp', method: 'GET', timeout: 1000 },
        () => resolve(true),
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => { req.destroy(); resolve(false) })
      req.end()
    })
    if (ready) return true
    await new Promise(r => setTimeout(r, 1000))
    process.stdout.write('.')
  }
  return false
}

/** Find the most recently written platform_worker log file. */
function findWorkerLog(): string | null {
  try {
    const dirs = fs.readdirSync(LOG_BASE).filter(d => d.startsWith('platform_worker'))
    if (!dirs.length) return null
    const logs = dirs.flatMap(d =>
      fs.readdirSync(path.join(LOG_BASE, d)).map(f => path.join(LOG_BASE, d, f)),
    )
    return logs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Core deploy steps (reused by both initial run and watch loop)
// ---------------------------------------------------------------------------

/**
 * Build Swift binary, swap it into Beeper Desktop, apply local bundle patches, and restart Beeper.
 */
async function buildAndRestart(): Promise<void> {
  console.log('\n⚙️   Building Swift binary...')
  await shellExec('yarn', 'build:swift', '--debug')

  console.log('     Swapping SwiftServer.node...')
  const srcBinary = path.join(ROOT_DIR, 'binaries/darwin-arm64/SwiftServer.node')
  fs.copyFileSync(BEEPER_BINARY_DEST, BEEPER_BINARY_DEST + '.bak')
  fs.copyFileSync(srcBinary, BEEPER_BINARY_DEST)

  console.log('     Patching JS bundles (Bug #36 / #37)...')
  patchBundles()

  console.log('     Restarting Beeper Desktop...')
  try { await execAsync('killall "Beeper Desktop"') } catch { /* not running */ }
  await new Promise(r => setTimeout(r, 1500))
  await execAsync('open "/Applications/Beeper Desktop.app"')
  process.stdout.write('     Waiting for MCP on :23373 ')
  const ready = await waitForMcp()
  console.log(ready ? '\n     Ready.\n' : '\n     Timed out — Beeper may still be loading.\n')
}

/**
 * Watch Swift source files and re-run buildAndRestart on any change.
 * Debounces rapid saves with a 500ms window.
 */
function watchSwift(): void {
  const swiftSrcDir = path.join(ROOT_DIR, 'src/SwiftServer/Sources')
  console.log(`👀  Watching ${swiftSrcDir} for Swift changes...\n`)

  let debounce: ReturnType<typeof setTimeout> | null = null
  let isBuilding = false

  fs.watch(swiftSrcDir, { recursive: true }, (_, filename) => {
    if (!filename?.endsWith('.swift')) return
    if (isBuilding) return

    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(async () => {
      console.log(`\n🔄  ${filename} changed — rebuilding...`)
      isBuilding = true
      try {
        await buildAndRestart()
        console.log('✅  Done. Watching for next change...\n')
      } catch (err) {
        console.error('❌  Build failed:', err)
      } finally {
        isBuilding = false
      }
    }, 500)
  })
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isWatch = process.argv.includes('--watch')

async function main() {
  console.log(`\n🚀 Beeper iMessage — deploy${isWatch ? ' --watch' : ''}\n`)

  // Initial full deploy
  await buildAndRestart()

  // Open log tails (only on first run)
  console.log('Opening log tails...')
  const swiftLog = path.join(LOG_BASE, 'platform-imessage.log')
  const workerLog = findWorkerLog()

  await openCursorTab(`tail -f "${swiftLog}"`)
  await new Promise(r => setTimeout(r, 800))

  if (workerLog) {
    await openCursorTab(`tail -f "${workerLog}"`)
  } else {
    console.log('Worker log not found yet — will appear after Beeper fully loads')
  }

  console.log('\n✅  Deploy complete.\n')

  if (isWatch) watchSwift()
}

main().catch(err => {
  console.error('\n❌ Deploy failed:', err)
  process.exit(1)
})
