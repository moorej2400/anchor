import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectArtifacts,
  readToolchainPins,
  verifyVersion,
  writeChecksums,
} from './release-tools.mjs'

const expectedArtifacts = [
  'Anchor_0.1.0_linux_x86_64.AppImage',
  'Anchor_0.1.0_linux_x86_64.deb',
  'Anchor_0.1.0_linux_x86_64.rpm',
  'Anchor_0.1.0_macos_aarch64.dmg',
  'Anchor_0.1.0_macos_x86_64.dmg',
  'Anchor_0.1.0_windows_x86_64-setup.exe',
]

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), `anchor-${prefix}-`))
}

async function makeProject(packageVersion, tauriVersion) {
  const root = await temporaryDirectory('version')
  await mkdir(path.join(root, 'src-tauri'), { recursive: true })
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ version: packageVersion }),
  )
  await writeFile(
    path.join(root, 'src-tauri', 'tauri.conf.json'),
    JSON.stringify({ version: tauriVersion }),
  )
  return root
}

async function makeBundleFixture() {
  const root = await temporaryDirectory('bundles')
  const source = path.join(root, 'source')
  const destination = path.join(root, 'destination')
  const files = [
    ['appimage', 'anchor_0.1.0_amd64.AppImage'],
    ['deb', 'anchor_0.1.0_amd64.deb'],
    ['rpm', 'anchor-0.1.0-1.x86_64.rpm'],
  ]

  for (const [directory, name] of files) {
    const bundleDirectory = path.join(source, directory)
    await mkdir(bundleDirectory, { recursive: true })
    await writeFile(path.join(bundleDirectory, name), `${directory}\n`)
  }

  return { destination, source }
}

async function makeInventoryFixture({ omit, extra } = {}) {
  const root = await temporaryDirectory('inventory')
  for (const name of expectedArtifacts) {
    if (name !== omit) {
      await writeFile(path.join(root, name), `${name}\n`)
    }
  }
  if (extra) {
    await writeFile(path.join(root, extra), 'unexpected\n')
  }
  return root
}

test('accepts a tag that matches both project versions', async () => {
  const root = await makeProject('0.1.0', '0.1.0')

  assert.equal(await verifyVersion(root, 'v0.1.0'), '0.1.0')
})

test('rejects mismatched project versions', async () => {
  const root = await makeProject('0.1.0', '0.2.0')

  await assert.rejects(
    () => verifyVersion(root, 'v0.1.0'),
    /project version mismatch/,
  )
})

test('rejects a tag that does not match the project version', async () => {
  const root = await makeProject('0.1.0', '0.1.0')

  await assert.rejects(
    () => verifyVersion(root, 'v0.2.0'),
    /tag v0\.2\.0 does not match project version 0\.1\.0/,
  )
})

test('pins the minimum Rust version required by the locked dependencies', async () => {
  const repositoryRoot = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    '..',
    '..',
  )

  assert.deepEqual(await readToolchainPins(repositoryRoot), {
    linux: '1.89.0',
    macos: '1.89.0',
    windows: '1.89.0',
  })
})

test('collects one artifact for every Linux package type', async () => {
  const fixture = await makeBundleFixture()

  const copied = await collectArtifacts({
    platform: 'linux-x86_64',
    source: fixture.source,
    destination: fixture.destination,
    version: '0.1.0',
  })

  assert.deepEqual(copied.map((file) => path.basename(file)), [
    'Anchor_0.1.0_linux_x86_64.AppImage',
    'Anchor_0.1.0_linux_x86_64.deb',
    'Anchor_0.1.0_linux_x86_64.rpm',
  ])
})

test('rejects duplicate source artifacts for one package type', async () => {
  const fixture = await makeBundleFixture()
  await writeFile(
    path.join(fixture.source, 'deb', 'anchor_0.1.0_duplicate.deb'),
    'duplicate\n',
  )

  await assert.rejects(
    () =>
      collectArtifacts({
        platform: 'linux-x86_64',
        source: fixture.source,
        destination: fixture.destination,
        version: '0.1.0',
      }),
    /expected exactly one \.deb artifact, found 2/,
  )
})

test('writes sorted checksums for the complete release inventory', async () => {
  const root = await makeInventoryFixture()

  const checksumPath = await writeChecksums(root, '0.1.0')
  const lines = (await readFile(checksumPath, 'utf8')).trim().split('\n')

  assert.equal(lines.length, expectedArtifacts.length)
  assert.deepEqual(
    lines.map((line) => line.slice(line.indexOf('  ') + 2)),
    [...expectedArtifacts].sort(),
  )
  assert.ok(lines.every((line) => /^[a-f0-9]{64}  Anchor_/.test(line)))
})

test('rejects incomplete final inventories', async () => {
  const root = await makeInventoryFixture({
    omit: 'Anchor_0.1.0_macos_x86_64.dmg',
  })

  await assert.rejects(
    () => writeChecksums(root, '0.1.0'),
    /missing release artifact: Anchor_0\.1\.0_macos_x86_64\.dmg/,
  )
})

test('rejects unexpected final release files', async () => {
  const root = await makeInventoryFixture({ extra: 'debug.log' })

  await assert.rejects(
    () => writeChecksums(root, '0.1.0'),
    /unexpected release artifact: debug\.log/,
  )
})
