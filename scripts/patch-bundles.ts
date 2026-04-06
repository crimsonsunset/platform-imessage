import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const BEEPER_APP = '/Applications/Beeper Desktop.app'
const BUILD_MAIN = path.join(BEEPER_APP, 'Contents/Resources/app/build/main')

/** One find/replace step against a resolved bundle file. */
type PatchStep = {
  description: string
  find: string
  replace: string
  /** If `find` is missing but this substring exists, the step is treated as already applied. */
  alreadyAppliedMarker?: string
}

/** A bundle file located by scanning for `fileSignature`. */
type BundlePatchGroup = {
  description: string
  fileSignature: string
  steps: PatchStep[]
}

const BUG_37_GROUP: BundlePatchGroup = {
  description: 'Bug #37 — contact names (mapParticipant + mapThread)',
  fileSignature: 'SwiftServer.node',
  steps: [
    {
      description: 'mapParticipant — lookupContact for email and phone',
      find: 'a?r.fullName=n:i?r.email=e:l?r.phoneNumber=e:D3e(y)',
      replace:
        'a?r.fullName=n:i?(r.email=e,r.fullName=an?.lookupContact?.(e)):l?(r.phoneNumber=e,r.fullName=an?.lookupContact?.(e)):D3e(y)',
      alreadyAppliedMarker: 'r.fullName=an?.lookupContact?.(e)):l?(r.phoneNumber=e,r.fullName=an?.lookupContact?.(e))',
    },
    {
      description: 'mapThread — 1:1 title from chat_identifier',
      find: 'title:e.display_name,imgURL',
      replace: 'title:e.display_name||(!h?an?.lookupContact?.(e.chat_identifier):void 0),imgURL',
      alreadyAppliedMarker: 'title:e.display_name||(!h?an?.lookupContact?.(e.chat_identifier):void 0),imgURL',
    },
  ],
}

const BUG_36_HP_ORIGINAL =
  'const Hp=async t=>{const e=await t.accounts.list();if(!e||e.length===0)throw new Error("No accounts found. This should never happen, please contact help@beeper.com.");const a=[];a.push("# Accounts");for(const s of e){if(!s.user){a.push(`\n## ${s.network}`),a.push(`**Account ID**: \\`${s.accountID}\\``),a.push("**User**: Unknown");continue}const r=s.user.fullName||s.user.username||s.user.id;a.push(`\n## ${s.network}`),a.push(`**Account ID**: \\`${s.accountID}\\``),a.push(`**User**: ${r}`),s.user.email&&a.push(`**Email**: ${s.user.email}`),s.user.phoneNumber&&a.push(`**Phone**: ${s.user.phoneNumber}`)}return a.push(`\n# Using this information\n`),a.push("- Pass accountIDs to narrow chat/message queries when known."),Nt(a)},un='

const BUG_36_HP_PATCHED =
  'const Hp=async t=>{const e=await t.accounts.list();if(!e||e.length===0)throw new Error("No accounts found. This should never happen, please contact help@beeper.com.");let i=[...e];if(!e.some(n=>typeof n.accountID=="string"&&n.accountID.startsWith("imessage_")))try{const{default:o}=await import("better-sqlite3"),{homedir:d}=await import("os"),l=o(d()+"/Library/Application Support/BeeperTexts/index.db",{readonly:!0}),f=l.prepare("SELECT accountID,platformName,user FROM accounts WHERE platformName=\'imessage\' LIMIT 1").get();l.close();if(f){let n=null;try{n=f.user?JSON.parse(f.user):null}catch{}i.push({accountID:f.accountID,network:"iMessage",user:n?{id:n.id,fullName:n.displayText||n.email||n.id,email:n.email}:void 0})}}catch(m){i.push({accountID:"imessage_patch_error",network:"iMessage",_warning:String(m&&m.message||m)})}const a=[];a.push("# Accounts");for(const s of i){if(s._warning){a.push(`\n## ${s.network}`),a.push(`> Warning: ${s._warning}`);continue}if(!s.user){a.push(`\n## ${s.network}`),a.push(`**Account ID**: \\`${s.accountID}\\``),a.push("**User**: Unknown");continue}const r=s.user.fullName||s.user.username||s.user.id;a.push(`\n## ${s.network}`),a.push(`**Account ID**: \\`${s.accountID}\\``),a.push(`**User**: ${r}`),s.user.email&&a.push(`**Email**: ${s.user.email}`),s.user.phoneNumber&&a.push(`**Phone**: ${s.user.phoneNumber}`)}return a.push(`\n# Using this information\n`),a.push("- Pass accountIDs to narrow chat/message queries when known."),Nt(a)},un='

const BUG_36_GROUP: BundlePatchGroup = {
  description: 'Bug #36 — get_accounts includes iMessage (index.db)',
  fileSignature: 'No accounts found. This should never happen, please contact help@beeper.com.',
  steps: [
    {
      description: 'Hp handler — merge platform-sdk iMessage row from index.db',
      find: BUG_36_HP_ORIGINAL,
      replace: BUG_36_HP_PATCHED,
      alreadyAppliedMarker: "platformName='imessage' LIMIT 1",
    },
  ],
}

const PATCH_GROUPS: BundlePatchGroup[] = [BUG_37_GROUP, BUG_36_GROUP]

/**
 * Returns the path to the first `.mjs` file under `BUILD_MAIN` whose content includes `signature`.
 */
function findBundleBySignature(signature: string): string | null {
  let entries: string[] = []
  try {
    entries = fs.readdirSync(BUILD_MAIN)
  } catch {
    return null
  }

  for (const name of entries) {
    if (!name.endsWith('.mjs')) continue
    const fullPath = path.join(BUILD_MAIN, name)
    let content: string
    try {
      content = fs.readFileSync(fullPath, 'utf8')
    } catch {
      continue
    }
    if (content.includes(signature)) return fullPath
  }
  return null
}

/**
 * Builds a short excerpt around the first occurrence of `needle` for error messages.
 */
function contextAround(content: string, needle: string, radius = 220): string {
  const idx = content.indexOf(needle)
  if (idx === -1) return '(signature not found in resolved file)'
  const start = Math.max(0, idx - radius)
  const end = Math.min(content.length, idx + needle.length + radius)
  return content.slice(start, end)
}

/**
 * Writes `originalContent` to `filePath + '.bak'` if that backup does not already exist.
 */
function ensureBackup(filePath: string, originalContent: string): void {
  const bakPath = `${filePath}.bak`
  if (fs.existsSync(bakPath)) return
  fs.writeFileSync(bakPath, originalContent, 'utf8')
}

/**
 * Applies all configured patch groups to Beeper Desktop bundles under `BUILD_MAIN`.
 * Throws if a bundle cannot be resolved or a required find-string is missing.
 */
export function patchBundles(): void {
  if (!fs.existsSync(BUILD_MAIN)) {
    throw new Error(
      `Beeper build/main not found: ${BUILD_MAIN}\nInstall or update Beeper Desktop, then retry.`,
    )
  }

  const filePatches = new Map<string, { original: string; content: string; description: string }>()

  for (const group of PATCH_GROUPS) {
    const filePath = findBundleBySignature(group.fileSignature)
    if (!filePath) {
      throw new Error(
        `[${group.description}] No bundle under ${BUILD_MAIN} contains signature:\n` +
          `  ${group.fileSignature.slice(0, 120)}${group.fileSignature.length > 120 ? '…' : ''}\n` +
          'Beeper may have reorganized its build output.',
      )
    }

    const existing = filePatches.get(filePath)
    let content: string
    if (existing) {
      content = existing.content
    } else {
      content = fs.readFileSync(filePath, 'utf8')
      filePatches.set(filePath, { original: content, content, description: path.basename(filePath) })
    }

    for (const step of group.steps) {
      if (content.includes(step.find)) {
        content = content.replace(step.find, step.replace)
        continue
      }
      if (step.alreadyAppliedMarker && content.includes(step.alreadyAppliedMarker)) {
        console.log(`     (skip) ${group.description} — ${step.description} already applied`)
        continue
      }
      throw new Error(
        `[${group.description}] ${step.description}\n` +
          `Find string not found in ${path.basename(filePath)}.\n` +
          'Beeper likely updated — re-identify the patch target in scripts/patch-bundles.ts.\n' +
          `Context around file signature:\n${contextAround(content, group.fileSignature)}`,
      )
    }

    const entry = filePatches.get(filePath)
    if (entry) entry.content = content
  }

  for (const [filePath, { original, content }] of filePatches) {
    if (content === original) {
      console.log(`     (unchanged) ${path.basename(filePath)}`)
      continue
    }
    ensureBackup(filePath, original)
    fs.writeFileSync(filePath, content, 'utf8')
    console.log(`     Patched ${path.basename(filePath)}`)
  }
}

function isRunDirectly(): boolean {
  const entry = path.resolve(fileURLToPath(import.meta.url))
  const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : ''
  return entry === argv1
}

if (isRunDirectly()) {
  console.log('\n📦  Patching Beeper Desktop bundles...\n')
  try {
    patchBundles()
    console.log('\n✅  patch-bundles complete.\n')
  } catch (err) {
    console.error('\n❌  patch-bundles failed:', err)
    process.exit(1)
  }
}
