import { spawn } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, '..')

async function run() {
  // Sync dev icon on macOS to avoid showing the default Electron icon in dev mode
  if (process.platform === 'darwin') {
    const electronIcnsPath = path.resolve(
      rootDir,
      'node_modules/electron/dist/Electron.app/Contents/Resources/electron.icns',
    )
    const sourceIcnsPath = path.resolve(rootDir, 'build/darwin/icons.icns')
    if (fs.existsSync(electronIcnsPath) && fs.existsSync(sourceIcnsPath)) {
      try {
        fs.copyFileSync(sourceIcnsPath, electronIcnsPath)
      } catch {
        // Non-critical if electron binary directory is read-only
      }
    }
  }

  // 0. Ensure native binaries (rg, fd) are downloaded and prepared
  console.log('[dev] Ensuring native binaries (rg, fd)...')
  await new Promise((resolve, reject) => {
    const download = spawn('node', ['scripts/download-binaries.js'], { cwd: rootDir, stdio: 'inherit' })
    download.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`download-binaries failed with exit code ${code}`))
    })
  })

  // 1. Build workspace packages (@cpa/*)
  console.log('[dev] Building workspace packages...')
  await new Promise((resolve, reject) => {
    const pkgBuild = spawn('pnpm', ['--filter', '@cpa/*', 'build'], { cwd: rootDir, stdio: 'inherit' })
    pkgBuild.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`workspace package build failed with exit code ${code}`))
    })
  })

  // 2. Build main & preload first
  console.log('[dev] Compiling electron main & preload...')
  await new Promise((resolve, reject) => {
    const tsc = spawn('pnpm', ['build:main'], { cwd: rootDir, stdio: 'inherit' })
    tsc.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tsc failed with exit code ${code}`))
    })
  })

  // 3. Start Vite dev server
  console.log('[dev] Starting Vite dev server...')
  const vite = spawn('pnpm', ['--dir', 'frontend', 'dev'], {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'inherit'],
  })

  let devServerUrl = ''

  vite.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    process.stdout.write(chunk)
    const match = text.match(/http:\/\/127\.0\.0\.1:\d+|http:\/\/localhost:\d+/)
    if (match && !devServerUrl) {
      devServerUrl = match[0]
      console.log(`[dev] Detected Vite dev server at ${devServerUrl}`)
      startElectron(devServerUrl, vite)
    }
  })

  vite.on('close', () => {
    process.exit(0)
  })
}

function startElectron(url, viteProc) {
  console.log('[dev] Launching Electron...')
  const electron = spawn(
    'pnpm',
    ['exec', 'electron', 'dist-electron/src/main/index.js'],
    {
      cwd: rootDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_DEV_SERVER_URL: url,
      },
      stdio: 'inherit',
    },
  )

  electron.on('close', () => {
    console.log('[dev] Electron closed, stopping dev server...')
    viteProc.kill('SIGTERM')
    process.exit(0)
  })
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
