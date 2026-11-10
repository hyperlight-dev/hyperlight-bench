import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const phase = process.argv[2] ?? 'all'
const compile = ['compile-native-aot', 'compile-pulley-aot'].includes(phase)
if (!['wit', 'jco', 'qjs', 'rust-wasm', 'dummy', 'hluk', 'inputs', 'servers', 'all'].includes(phase) && !compile) throw new Error(`Unknown build phase: ${phase}`)
const flavor = phase === 'servers' ? process.argv[3] ?? 'all' : 'all'
const serverFlavors = ['native', 'pulley', 'hluk-kvm', 'hluk-mshv']
if (![...serverFlavors, 'all'].includes(flavor)) throw new Error(`Unknown server flavor: ${flavor}`)
if (process.argv[3] && phase !== 'servers' && !compile) throw new Error('Extra arguments require servers or AOT compilation')
if (process.argv.length > (compile || phase === 'servers' ? 5 : 3)) throw new Error('Too many build arguments')

function run(command: string, args: string[], cwd = root, env = process.env) {
  const child = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`${command} exited with ${child.status ?? child.signal}`)
}

function requireArtifact(path: string) {
  const file = statSync(path)
  if (!file.isFile() || file.size === 0) throw new Error(`Missing or empty build artifact: ${path}`)
}

function generate(path: string, command: string, args: string[], cwd = root) {
  mkdirSync(dirname(path), { recursive: true })
  rmSync(path, { force: true })
  run(command, args, cwd)
  requireArtifact(path)
}

function compileAot(input: string, output: string, pulley: boolean) {
  requireArtifact(input)
  generate(output, 'hyperlight-wasm-aot', ['compile', '--component', ...(pulley ? ['--pulley'] : []), input, output])
}

if (compile) {
  const input = process.argv[3]
  const output = process.argv[4]
  if (!input || !output) throw new Error('AOT compilation requires input and output paths')
  if (resolve(input) === resolve(output)) throw new Error('AOT input and output must differ')
  compileAot(input, output, phase === 'compile-pulley-aot')
}

if (['wit', 'jco', 'qjs', 'rust-wasm', 'inputs', 'all'].includes(phase)) {
  generate('js/src/wit/handler_wit.wasm', 'wasm-tools', ['component', 'wit', 'js/src/wit/handler.wit', '-w', '-o', 'js/src/wit/handler_wit.wasm'])
}

if (['jco', 'inputs', 'all'].includes(phase)) {
  run('npm', ['ci'], resolve('js/default'))
  const jco = JSON.parse(readFileSync('js/default/node_modules/@bytecodealliance/jco/package.json', 'utf8'))
  generate('js/default/handler.wasm', process.execPath, [resolve('js/default/node_modules/@bytecodealliance/jco', jco.bin.jco), 'componentize', '../src/handler.js', '--wit', '../src/wit/handler.wit', '-d', 'all', '-o', 'handler.wasm'], resolve('js/default'))
}
if (['qjs', 'inputs', 'all'].includes(phase)) {
  generate('js/componentize-qjs/handler.wasm', 'componentize-qjs', ['--stub-wasi', '--wit', 'js/src/wit/handler.wit', '--js', 'js/src/handler.js', '-o', 'js/componentize-qjs/handler.wasm'])
}
if (['rust-wasm', 'inputs', 'all'].includes(phase)) {
  run('cargo', ['+nightly-2026-02-16', 'build', '-Zbuild-std=std', '--target', 'wasm32-wasip2', '--release', '--locked'], resolve('crates/handler-rs'), { ...process.env, RUSTFLAGS: '-Zunstable-options -Cpanic=immediate-abort' })
  requireArtifact('crates/handler-rs/target/wasm32-wasip2/release/handler_rs.wasm')
}
if (['inputs', 'all'].includes(phase)) {
  const components = [
    ['js/default/handler.wasm', 'js/default/handler.aot', 'js/pulley/handler.aot'],
    ['js/componentize-qjs/handler.wasm', 'js/componentize-qjs/handler.aot', 'js/componentize-qjs/handler.pulley.aot'],
    ['crates/handler-rs/target/wasm32-wasip2/release/handler_rs.wasm', 'crates/handler-rs/target/wasm32-wasip2/release/handler_rs.aot', 'crates/handler-rs/target/wasm32-wasip2/release/handler_rs.pulley.aot'],
  ]
  for (const [input, native, pulley] of components) {
    compileAot(input, native, false)
    compileAot(input, pulley, true)
  }
}
if (['dummy', 'inputs', 'all'].includes(phase)) {
  run('cargo', ['hyperlight', 'build', '--release', '--locked'], resolve('crates/hyperlight-dummy-guest'))
  requireArtifact('crates/hyperlight-dummy-guest/target/x86_64-hyperlight-none/release/hyperlight-dummy-guest')
}

// hyperlight-unikraft rootfs images: the published runtimes, pinned to
// HLUK_VERSION by manifest digest, and the dummy driver's, built here.
async function pullHlukRootfs(runtime: string, version: string, digest: string, output: string) {
  const repository = `hyperlight-dev/hyperlight-unikraft/${runtime}`
  const token = (await (await fetch(`https://ghcr.io/token?service=ghcr.io&scope=repository:${repository}:pull`)).json()).token
  const get = async (path: string, accept?: string) => {
    const response = await fetch(`https://ghcr.io/v2/${repository}/${path}`, { headers: { Authorization: `Bearer ${token}`, ...(accept ? { Accept: accept } : {}) } })
    if (!response.ok) throw new Error(`ghcr.io/${repository}/${path}: ${response.status}`)
    return response
  }
  const manifestBytes = Buffer.from(await (await get(`manifests/${digest}`, 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json')).arrayBuffer())
  if (`sha256:${createHash('sha256').update(manifestBytes).digest('hex')}` !== digest) throw new Error(`${repository}@${digest}: manifest digest mismatch`)
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  if (manifest.layers?.length !== 1) throw new Error(`${repository}:initrd-v${version}: expected one layer`)
  const layer = manifest.layers[0]
  const blob = Buffer.from(await (await get(`blobs/${layer.digest}`)).arrayBuffer())
  if (`sha256:${createHash('sha256').update(blob).digest('hex')}` !== layer.digest) throw new Error(`${repository}: layer digest mismatch`)
  // The layer is a tar (gzip'd unless its media type says otherwise) holding initrd.cpio.
  const archive = `${output}.layer`
  writeFileSync(archive, blob)
  const tar = spawnSync('tar', [layer.mediaType?.endsWith('tar') ? '-xOf' : '-xzOf', archive, 'initrd.cpio'], { maxBuffer: 2 * 1024 ** 3 })
  rmSync(archive)
  if (tar.status !== 0) throw new Error(`${repository}: cannot unpack initrd.cpio: ${tar.stderr}`)
  writeFileSync(`${output}.part`, tar.stdout)
  renameSync(`${output}.part`, output)
  requireArtifact(output)
}

// A newc CPIO archive of directories and files, as the guest unpacks it.
function writeCpio(output: string, entries: { name: string, mode: number, data?: Buffer }[]) {
  const parts: Buffer[] = []
  const pad = (length: number) => Buffer.alloc((4 - (length % 4)) % 4)
  const header = (name: string, mode: number, size: number, ino: number) => {
    const fields = [ino, mode, 0, 0, 1, 0, size, 0, 0, 0, 0, name.length + 1, 0]
    const text = `070701${fields.map(value => value.toString(16).padStart(8, '0')).join('')}${name}\0`
    parts.push(Buffer.from(text, 'latin1'), pad(text.length))
  }
  entries.forEach((entry, index) => {
    header(entry.name, entry.mode, entry.data?.length ?? 0, index + 1)
    if (entry.data) parts.push(entry.data, pad(entry.data.length))
  })
  header('TRAILER!!!', 0, 0, 0)
  writeFileSync(output, Buffer.concat(parts))
  requireArtifact(output)
}

if (['hluk', 'inputs', 'all'].includes(phase)) {
  const toolVersions = readFileSync('tool-versions.sh', 'utf8')
  const pinned = (name: string) => process.env[name] ?? toolVersions.match(new RegExp(`${name}:=([^}]+)}`))?.[1]
  const version = pinned('HLUK_VERSION')
  if (!version) throw new Error('HLUK_VERSION is not set in tool-versions.sh')
  // The server's crate and these images must be the same release: the
  // kernel in the crate speaks the protocol of the drivers in the images.
  const crate = readFileSync('crates/server/Cargo.toml', 'utf8').match(/hyperlight-unikraft = \{ version = "=([^"]+)"/)?.[1]
  if (crate !== version) throw new Error(`hyperlight-unikraft ${crate} in crates/server/Cargo.toml is not HLUK_VERSION ${version}`)
  mkdirSync('artifacts/hluk', { recursive: true })
  for (const runtime of ['quickjs', 'node', 'python', 'dotnet-jit', 'wasmtime']) {
    const digest = pinned(`HLUK_DIGEST_${runtime.toUpperCase().replace('-', '_')}`)
    if (!digest) throw new Error(`no digest for the ${runtime} rootfs in tool-versions.sh`)
    console.log(`Fetching the hyperlight-unikraft ${runtime} rootfs (v${version}, ${digest.slice(0, 19)})`)
    await pullHlukRootfs(runtime, version, digest, `artifacts/hluk/${runtime}.cpio`)
  }
  // Static-pie against musl, as hyperlight-unikraft builds its own drivers:
  // a glibc static-pie from Ubuntu 22.04 crashes before main() in the guest.
  // gcc with musl's files rather than musl-gcc, whose 22.04 specs cannot
  // link a static-pie.
  const musl = { lib: '/usr/lib/x86_64-linux-musl', include: '/usr/include/x86_64-linux-musl' }
  if (!existsSync(`${musl.lib}/rcrt1.o`)) throw new Error(`no musl in ${musl.lib}: the hluk dummy driver needs it (Debian/Ubuntu: musl-dev)`)
  const gccFile = (flag: string) => spawnSync('gcc', [flag], { encoding: 'utf8' }).stdout.trim()
  generate('artifacts/hluk/hl_dummydriver', 'gcc', [
    '-O2', '-Wall', '-Wextra', '-Wno-unused-parameter', '-fPIE', '-static-pie',
    '-nostdinc', '-isystem', musl.include, '-isystem', gccFile('-print-file-name=include'), '-nostdlib',
    '-o', 'artifacts/hluk/hl_dummydriver',
    `${musl.lib}/rcrt1.o`, `${musl.lib}/crti.o`, 'crates/hluk-dummy/hl_dummydriver.c',
    `-L${musl.lib}`, '-lc', gccFile('-print-libgcc-file-name'), `${musl.lib}/crtn.o`,
  ])
  writeCpio('artifacts/hluk/dummy.cpio', [
    { name: 'tmp', mode: 0o41777 },
    { name: 'usr', mode: 0o40755 },
    { name: 'usr/local', mode: 0o40755 },
    { name: 'usr/local/bin', mode: 0o40755 },
    { name: 'usr/local/bin/hl_dummydriver', mode: 0o100755, data: readFileSync('artifacts/hluk/hl_dummydriver') },
  ])
}

if (['servers', 'all'].includes(phase)) {
  const executable = 'http-bench'
  if (!existsSync('target/hyperlight-js-runtime/x86_64-hyperlight-none/release/hyperlight-js-runtime')) {
    run('cargo', ['clean', '-p', 'hyperlight-js', '--release'])
  }
  for (const serverFlavor of flavor === 'all' ? serverFlavors : [flavor]) {
    // The hluk flavors build without the classic runtimes, so without
    // hyperlight-host's mshv3 on KVM (see crates/server/Cargo.toml).
    const hluk = { 'hluk-kvm': 'hluk', 'hluk-mshv': 'hluk-mshv' }[serverFlavor]
    const features = [hluk ?? (serverFlavor === 'pulley' ? 'pulley' : ''), phase === 'servers' ? process.argv[4] ?? '' : ''].filter(Boolean).join(',')
    if (!hluk) run('cargo', ['clean', '-p', 'hyperlight-wasm', '--release'])
    run('cargo', ['build', '--release', '--locked', ...(hluk ? ['--no-default-features'] : []), ...(features ? ['--features', features] : [])])
    requireArtifact(`target/release/${executable}`)
    mkdirSync(`artifacts/bin/${serverFlavor}`, { recursive: true })
    copyFileSync(`target/release/${executable}`, `artifacts/bin/${serverFlavor}/${executable}`)
  }
  const capture = (command: string, args: string[]) => {
    const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  const metadata = JSON.parse(capture('cargo', ['metadata', '--locked', '--format-version', '1']))
  writeFileSync('artifacts/build-info.json', JSON.stringify({
    tools: { rustc: capture('rustc', ['--version']), cargo: capture('cargo', ['--version']) },
    dependencies: Object.fromEntries(metadata.packages.map((entry: { name: string, version: string }) => [`${entry.name}@${entry.version}`, entry.version])),
  }, null, 2))
}