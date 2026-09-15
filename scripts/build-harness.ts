import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
process.chdir(root)
const phase = process.argv[2] ?? 'all'
const compile = ['compile-native-aot', 'compile-pulley-aot'].includes(phase)
if (!['wit', 'jco', 'qjs', 'rust-wasm', 'dummy', 'inputs', 'servers', 'all'].includes(phase) && !compile) throw new Error(`Unknown build phase: ${phase}`)
const flavor = phase === 'servers' ? process.argv[3] ?? 'all' : 'all'
if (!['native', 'pulley', 'all'].includes(flavor)) throw new Error(`Unknown server flavor: ${flavor}`)
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

if (['servers', 'all'].includes(phase)) {
  const executable = 'http-bench'
  for (const serverFlavor of flavor === 'all' ? ['native', 'pulley'] : [flavor]) {
    const features = [serverFlavor === 'pulley' ? 'pulley' : '', phase === 'servers' ? process.argv[4] ?? '' : ''].filter(Boolean).join(',')
    run('cargo', ['clean', '-p', 'hyperlight-wasm', '--release'])
    run('cargo', ['build', '--release', '--locked', ...(features ? ['--features', features] : [])])
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