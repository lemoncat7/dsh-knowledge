import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const options = { timeout: 2000, maxBuffer: 128 * 1024, env: { ...process.env, LC_ALL: 'C' } }

/** Disk Arbitration supplies the filesystem UUID for local macOS volumes. */
export async function vaultVolumeUUID(path: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return
  try {
    const { stdout: mount } = await exec('/bin/df', ['-P', path], options)
    const device = mount.split('\n')[1]?.match(/^\/dev\/disk\d+(?:s\d+)*\s/)?.[0]?.trim()
    if (!device) return // Network and other filesystems may not expose a volume UUID.
    const { stdout: info } = await exec('/usr/sbin/diskutil', ['info', '-plist', device], options)
    return info.match(/<key>VolumeUUID<\/key>\s*<string>([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})<\/string>/i)?.[1]?.toLowerCase()
  } catch { /* Some mounts do not expose a stable UUID. */ }
}
