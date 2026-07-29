import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// These normalized names are the public download contract shared by CI,
// release notes, and checksum verification.
function platformContracts(version) {
  return {
    'linux-x86_64': [
      ['.AppImage', `Anchor_${version}_linux_x86_64.AppImage`],
      ['.deb', `Anchor_${version}_linux_x86_64.deb`],
      ['.rpm', `Anchor_${version}_linux_x86_64.rpm`],
    ],
    'windows-x86_64': [
      ['-setup.exe', `Anchor_${version}_windows_x86_64-setup.exe`],
    ],
    'macos-aarch64': [
      ['.dmg', `Anchor_${version}_macos_aarch64.dmg`],
    ],
    'macos-x86_64': [
      ['.dmg', `Anchor_${version}_macos_x86_64.dmg`],
    ],
  }
}

function assertVersion(version) {
  if (!semverPattern.test(version)) {
    throw new Error(`invalid release version: ${version}`)
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listFiles(entryPath)))
    } else if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

async function sha256(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

export async function verifyVersion(root, tag) {
  const match = /^v(.+)$/.exec(tag)
  if (!match) {
    throw new Error(`release tag must start with v: ${tag}`)
  }

  const tagVersion = match[1]
  assertVersion(tagVersion)

  const packageJson = await readJson(path.join(root, 'package.json'))
  const tauriConfig = await readJson(
    path.join(root, 'src-tauri', 'tauri.conf.json'),
  )

  if (packageJson.version !== tauriConfig.version) {
    throw new Error(
      `project version mismatch: package.json=${packageJson.version}, ` +
        `tauri.conf.json=${tauriConfig.version}`,
    )
  }
  if (tagVersion !== packageJson.version) {
    throw new Error(
      `tag ${tag} does not match project version ${packageJson.version}`,
    )
  }

  return tagVersion
}

export async function collectArtifacts({
  platform,
  source,
  destination,
  version,
}) {
  assertVersion(version)
  const contract = platformContracts(version)[platform]
  if (!contract) {
    throw new Error(`unsupported release platform: ${platform}`)
  }

  const sourceFiles = await listFiles(source)
  const selected = contract.map(([suffix, outputName]) => {
    const matches = sourceFiles.filter((file) => file.endsWith(suffix))
    if (matches.length !== 1) {
      throw new Error(
        `expected exactly one ${suffix} artifact, found ${matches.length}`,
      )
    }
    return [matches[0], outputName]
  })

  await mkdir(destination, { recursive: true })
  const outputs = []
  for (const [sourceFile, outputName] of selected) {
    const destinationFile = path.join(destination, outputName)
    await copyFile(sourceFile, destinationFile)
    outputs.push(destinationFile)
  }

  return outputs
}

export async function writeChecksums(root, version) {
  assertVersion(version)
  const expected = Object.values(platformContracts(version))
    .flat()
    .map(([, outputName]) => outputName)
    .sort()
  const expectedSet = new Set(expected)
  const actual = (await readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name !== 'SHA256SUMS.txt')
    .map((entry) => entry.name)
    .sort()

  for (const name of expected) {
    if (!actual.includes(name)) {
      throw new Error(`missing release artifact: ${name}`)
    }
  }
  for (const name of actual) {
    if (!expectedSet.has(name)) {
      throw new Error(`unexpected release artifact: ${name}`)
    }
  }

  const lines = []
  for (const name of expected) {
    lines.push(`${await sha256(path.join(root, name))}  ${name}`)
  }

  const checksumPath = path.join(root, 'SHA256SUMS.txt')
  await writeFile(checksumPath, `${lines.join('\n')}\n`)
  return checksumPath
}

async function runCli(argv) {
  const [command, ...args] = argv

  if (command === 'verify-version') {
    const [tag, root = '.'] = args
    if (!tag) throw new Error('verify-version requires <tag> [root]')
    process.stdout.write(`${await verifyVersion(path.resolve(root), tag)}\n`)
    return
  }

  if (command === 'collect') {
    const [platform, source, destination, version] = args
    if (!platform || !source || !destination || !version) {
      throw new Error(
        'collect requires <platform> <source> <destination> <version>',
      )
    }
    const outputs = await collectArtifacts({
      platform,
      source: path.resolve(source),
      destination: path.resolve(destination),
      version,
    })
    process.stdout.write(`${outputs.join('\n')}\n`)
    return
  }

  if (command === 'checksums') {
    const [root, version] = args
    if (!root || !version) {
      throw new Error('checksums requires <root> <version>')
    }
    process.stdout.write(`${await writeChecksums(path.resolve(root), version)}\n`)
    return
  }

  throw new Error(
    'usage: release-tools.mjs <verify-version|collect|checksums> ...',
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
