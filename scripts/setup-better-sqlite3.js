import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function setupBetterSqlite3() {
    if (process.env.SKIP_NATIVE_BUILD === '1' || process.env.CPA_SKIP_NATIVE_BUILD === '1') {
        console.log('[setup-better-sqlite3] Native compilation skipped (SKIP_NATIVE_BUILD is set).')
        return
    }

    try {
        const pkgPath = require.resolve('better-sqlite3/package.json')
        const pkgDir = path.dirname(pkgPath)

        let electronVer = '44.0.0'
        try {
            const electronPkg = require('electron/package.json')
            electronVer = electronPkg.version
        } catch {
            // Use default fallback
        }

        const hostNodePreGyp = `node-v${process.versions.modules}-${process.platform}-${process.arch}`

        let electronNodePreGyp = ''
        try {
            const electronBin = require('electron')
            const out = execSync(`"${electronBin}" -e "process.stdout.write('node-v' + process.versions.modules + '-' + process.platform + '-' + process.arch)"`, {
                env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
                encoding: 'utf8'
            })
            electronNodePreGyp = out.trim()
        } catch {
            electronNodePreGyp = `node-v132-${process.platform}-${process.arch}`
        }

        console.log(`[setup-better-sqlite3] Electron ABI: ${electronNodePreGyp} (Electron ${electronVer})`)
        console.log(`[setup-better-sqlite3] Host Node ABI: ${hostNodePreGyp} (Node ${process.versions.node})`)

        const electronDestDir = path.join(pkgDir, 'lib', 'binding', electronNodePreGyp)
        const electronDestFile = path.join(electronDestDir, 'better_sqlite3.node')
        const hostDestDir = path.join(pkgDir, 'lib', 'binding', hostNodePreGyp)
        const hostDestFile = path.join(hostDestDir, 'better_sqlite3.node')
        const releaseNode = path.join(pkgDir, 'build', 'Release', 'better_sqlite3.node')

        const cacheBaseDir = process.env.NATIVE_CACHE_DIR
            ? path.resolve(process.env.NATIVE_CACHE_DIR)
            : path.join(os.homedir(), '.cache', 'cpa-native-bindings')
        const cachedElectronDir = path.join(cacheBaseDir, 'better-sqlite3', electronNodePreGyp)
        const cachedElectronFile = path.join(cachedElectronDir, 'better_sqlite3.node')
        const cachedHostDir = path.join(cacheBaseDir, 'better-sqlite3', hostNodePreGyp)
        const cachedHostFile = path.join(cachedHostDir, 'better_sqlite3.node')

        let electronOk = false
        let hostOk = false

        // 1. Fetch or build Electron prebuild
        if (!fs.existsSync(electronDestFile)) {
            // Check persistent local cache for Electron binding
            if (fs.existsSync(cachedElectronFile) && fs.statSync(cachedElectronFile).size > 0) {
                try {
                    fs.mkdirSync(electronDestDir, { recursive: true })
                    fs.copyFileSync(cachedElectronFile, electronDestFile)
                    console.log(`[setup-better-sqlite3] Restored Electron binary from cache: ${cachedElectronFile}`)
                } catch (cacheErr) {
                    console.warn('[setup-better-sqlite3] Failed to restore Electron binary from cache:', cacheErr)
                }
            }
        }

        if (!fs.existsSync(electronDestFile)) {
            try {
                execSync(`npx prebuild-install --runtime electron --target ${electronVer}`, { cwd: pkgDir, stdio: 'pipe' })
                if (fs.existsSync(releaseNode)) {
                    fs.mkdirSync(electronDestDir, { recursive: true })
                    fs.copyFileSync(releaseNode, electronDestFile)
                }
            } catch {
                console.log(`[setup-better-sqlite3] Prebuild not found for Electron ${electronVer}, compiling from source with node-gyp...`)
                try {
                    execSync(`npx --package=node-gyp node-gyp rebuild --target=${electronVer} --arch=${process.arch} --dist-url=https://electronjs.org/headers`, { cwd: pkgDir, stdio: 'inherit' })
                    if (fs.existsSync(releaseNode)) {
                        fs.mkdirSync(electronDestDir, { recursive: true })
                        fs.copyFileSync(releaseNode, electronDestFile)
                    }
                } catch (compileErr) {
                    console.warn('[setup-better-sqlite3] Failed to compile Electron binary:', compileErr)
                }
            }
        }
        if (fs.existsSync(electronDestFile) && fs.statSync(electronDestFile).size > 0) {
            electronOk = true
            console.log('[setup-better-sqlite3] Electron binary configured successfully.')
            try {
                fs.mkdirSync(cachedElectronDir, { recursive: true })
                fs.copyFileSync(electronDestFile, cachedElectronFile)
                console.log(`[setup-better-sqlite3] Saved Electron binary to cache: ${cachedElectronFile}`)
            } catch {}
        }

        // 2. Fetch or build Host Node prebuild
        if (!fs.existsSync(hostDestFile)) {
            // Check persistent local cache for Host Node binding
            if (fs.existsSync(cachedHostFile) && fs.statSync(cachedHostFile).size > 0) {
                try {
                    fs.mkdirSync(hostDestDir, { recursive: true })
                    fs.copyFileSync(cachedHostFile, hostDestFile)
                    console.log(`[setup-better-sqlite3] Restored Host Node binary from cache: ${cachedHostFile}`)
                } catch (cacheErr) {
                    console.warn('[setup-better-sqlite3] Failed to restore Host Node binary from cache:', cacheErr)
                }
            }
        }

        if (!fs.existsSync(hostDestFile)) {
            try {
                execSync(`npx prebuild-install --runtime node --target ${process.versions.node}`, { cwd: pkgDir, stdio: 'pipe' })
                if (fs.existsSync(releaseNode)) {
                    fs.mkdirSync(hostDestDir, { recursive: true })
                    fs.copyFileSync(releaseNode, hostDestFile)
                }
            } catch {
                console.log(`[setup-better-sqlite3] Prebuild not found for Node ${process.versions.node}, compiling from source with node-gyp...`)
                try {
                    execSync(`npx --package=node-gyp node-gyp rebuild`, { cwd: pkgDir, stdio: 'inherit' })
                    if (fs.existsSync(releaseNode)) {
                        fs.mkdirSync(hostDestDir, { recursive: true })
                        fs.copyFileSync(releaseNode, hostDestFile)
                    }
                } catch (compileErr) {
                    console.warn('[setup-better-sqlite3] Failed to compile Host Node binary:', compileErr)
                }
            }
        }
        if (fs.existsSync(hostDestFile) && fs.statSync(hostDestFile).size > 0) {
            hostOk = true
            console.log('[setup-better-sqlite3] Host Node binary configured successfully.')
            try {
                fs.mkdirSync(cachedHostDir, { recursive: true })
                fs.copyFileSync(hostDestFile, cachedHostFile)
                console.log(`[setup-better-sqlite3] Saved Host Node binary to cache: ${cachedHostFile}`)
            } catch {}
        }

        // 3. Remove build/Release/better_sqlite3.node ONLY if BOTH Electron and Host bindings exist in lib/binding/
        if (electronOk && hostOk) {
            if (fs.existsSync(releaseNode)) {
                fs.rmSync(releaseNode)
            }
            console.log('[setup-better-sqlite3] Both Electron and Host bindings verified in lib/binding. Cleaned build/Release.')
        } else {
            console.warn('[setup-better-sqlite3] Prebuild setup incomplete. Preserving build/Release/better_sqlite3.node.')
        }
    } catch (err) {
        console.warn('[setup-better-sqlite3] Setup skipped or failed:', err)
    }
}

setupBetterSqlite3()
