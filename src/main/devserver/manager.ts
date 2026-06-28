import { spawn, ChildProcess } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'

// ─── Vite plugin file templates ──────────────────────────────────────────────
// Written to <project>/.handybuilder/ the first time a Vite project is started.

const HB_PLUGIN_CODE = `// HandyBuilder source plugin — auto-generated, do not edit.
// Injects data-hb-file and data-hb-line onto every JSX element so HandyBuilder
// can map DOM nodes back to their source location without relying on text search.
import { createRequire } from 'module'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')
const _require = createRequire(import.meta.url)

let babel = null
const babelPath = process.env.HANDYBUILDER_BABEL_CORE_PATH
  || path.join(projectRoot, 'node_modules', '@babel', 'core')
try {
  babel = _require(babelPath)
  console.log('[hb-plugin] @babel/core loaded from', babelPath)
} catch (err) {
  console.warn('[hb-plugin] @babel/core not found at', babelPath, '— source attributes will not be injected')
  console.warn('[hb-plugin] error:', err?.message ?? String(err))
}

function babelHbPlugin({ types: t }) {
  return {
    visitor: {
      JSXOpeningElement(p, state) {
        // Skip if already stamped (idempotent)
        if (p.node.attributes.some(
          (a) => t.isJSXAttribute(a) && t.isJSXIdentifier(a.name, { name: 'data-hb-file' })
        )) return
        const loc = p.node.loc
        if (!loc) return
        const file = state.filename || ''
        p.node.attributes.push(
          t.jsxAttribute(t.jsxIdentifier('data-hb-file'), t.stringLiteral(file)),
          t.jsxAttribute(t.jsxIdentifier('data-hb-line'), t.stringLiteral(String(loc.start.line))),
          t.jsxAttribute(t.jsxIdentifier('data-hb-col'), t.stringLiteral(String(loc.start.column + 1)))
        )
      }
    }
  }
}

export function hbSourcePlugin() {
  console.log('[hb-plugin] HandyBuilder source plugin initialised (babel available:', babel !== null, ')')
  let printedTransformSample = false
  return {
    name: 'handybuilder-source',
    enforce: 'pre',
    configResolved(config) {
      const names = config.plugins.map((plugin) => plugin.name)
      const hbIndex = names.indexOf('handybuilder-source')
      const reactIndex = names.findIndex((name) => name.includes('react'))
      console.log('[hb-plugin] resolved plugin order:', names.join(' -> '))
      console.log('[hb-plugin] source plugin before React:', reactIndex === -1 || hbIndex < reactIndex,
        '(hb index:', hbIndex, 'react index:', reactIndex, ')')
    },
    transformIndexHtml: {
      order: 'pre',
      handler() {
        return [{
          tag: 'script',
          children: 'window.__HANDYBUILDER_SOURCE_PLUGIN_ACTIVE__ = true',
          injectTo: 'head-prepend'
        }]
      }
    },
    transform(code, id) {
      if (!babel) return null
      if (!id.match(/\\.(jsx|tsx)$/)) return null
      if (id.includes('node_modules')) return null
      console.log('[hb-plugin] transforming:', id)
      try {
        const result = babel.transformSync(code, {
          filename: id,
          plugins: [babelHbPlugin],
          parserOpts: { plugins: ['jsx', 'typescript'] },
          configFile: false,
          babelrc: false,
        })
        if (result?.code) {
          if (!printedTransformSample) {
            printedTransformSample = true
            console.log('[hb-plugin] transformed code sample for', id, '\\n' + result.code.slice(0, 1200))
          }
          return { code: result.code, map: null }
        }
        console.warn('[hb-plugin] babel returned no code for', id)
        return null
      } catch (err) {
        console.error('[hb-plugin] babel transform failed for', id, ':', err?.message ?? String(err))
        return null
      }
    }
  }
}
`

const HB_VITE_CONFIG_CODE = `// HandyBuilder dev config — auto-generated, do not edit.
// Wraps the project's own vite config and injects the source-annotation plugin.
import { mergeConfig, loadConfigFromFile, defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import { hbSourcePlugin } from './hb-source-plugin.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

console.log('[hb-config] HandyBuilder wrapper config loading from', projectRoot)

let userConfig = {}
try {
  const result = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    undefined,
    projectRoot
  )
  if (result?.config) {
    userConfig = result.config
    console.log('[hb-config] User vite config loaded from', result.path)
  } else {
    console.warn('[hb-config] loadConfigFromFile returned null — no user config found')
  }
} catch (err) {
  console.warn('[hb-config] Could not load user vite config:', err?.message ?? err)
  console.warn('[hb-config] Continuing with bare Vite config (user plugins not loaded)')
}

console.log('[hb-config] Merging configs and starting dev server')
export default mergeConfig(
  defineConfig({ configFile: false, plugins: [hbSourcePlugin()] }),
  userConfig
)
`

export type DevServerStatus = 'idle' | 'installing' | 'starting' | 'running' | 'stopped' | 'error'

interface DevServerCallbacks {
  onUrlDetected?: (url: string) => void
  onLog?: (log: string) => void
  onStatusChange?: (status: DevServerStatus) => void
}

const VITE_CONFIG_NAMES = [
  'vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs',
]

function isViteProject(projectPath: string): boolean {
  return VITE_CONFIG_NAMES.some((name) => fs.existsSync(path.join(projectPath, name)))
}

function writeHandyBuilderFiles(projectPath: string): void {
  const dir = path.join(projectPath, '.handybuilder')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'hb-source-plugin.mjs'), HB_PLUGIN_CODE, 'utf-8')
  fs.writeFileSync(path.join(dir, 'vite.config.hb.mjs'),   HB_VITE_CONFIG_CODE, 'utf-8')
}

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g

const URL_PATTERNS = [
  /Local:\s+(https?:\/\/[^\s\x1B\r\n]+)/,
  /local:\s+(https?:\/\/[^\s\x1B\r\n]+)/i,
  /(https?:\/\/localhost:\d+)/,
  /(https?:\/\/127\.0\.0\.1:\d+)/
]

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '')
}

function detectUrl(text: string): string | null {
  const clean = stripAnsi(text)
  for (const pattern of URL_PATTERNS) {
    const match = clean.match(pattern)
    if (match) return match[1].replace(/\/$/, '')
  }
  return null
}

export class DevServerManager {
  private process: ChildProcess | null = null
  private detectedUrl: string | null = null
  private callbacks: DevServerCallbacks = {}

  setCallbacks(callbacks: DevServerCallbacks): void {
    this.callbacks = callbacks
  }

  async start(projectPath: string): Promise<void> {
    await this.stop()
    this.detectedUrl = null

    const nodeModulesPath = path.join(projectPath, 'node_modules')
    if (!fs.existsSync(nodeModulesPath)) {
      this.emit('status', 'installing')
      this.emit('log', '[handybuilder] node_modules not found — running npm install...\n')
      try {
        await this.runNpmInstall(projectPath)
      } catch (err) {
        this.emit('status', 'error')
        this.emit('log', `[handybuilder] npm install failed: ${err}\n`)
        return
      }
    }

    this.emit('status', 'starting')

    // For Vite projects, write our source-annotation plugin and run vite directly
    // with a wrapper config that merges in the plugin.  For all other projects,
    // fall back to `npm run dev` (existing behaviour).
    let cmd: string
    let args: string[]

    if (isViteProject(projectPath)) {
      try {
        writeHandyBuilderFiles(projectPath)
        this.emit('log', '[handybuilder] Vite project detected — injecting source plugin\n')
      } catch (err) {
        this.emit('log', `[handybuilder] Warning: could not write .handybuilder files: ${err}\n`)
      }
      const viteBin = path.join(projectPath, 'node_modules', '.bin', 'vite')
      const hbConfig = path.join(projectPath, '.handybuilder', 'vite.config.hb.mjs')
      this.emit('log', `[handybuilder] Wrapper config: ${hbConfig} (exists: ${fs.existsSync(hbConfig)})\n`)
      cmd  = fs.existsSync(viteBin) ? viteBin : 'npx vite'
      args = ['--config', hbConfig]
    } else {
      cmd  = 'npm'
      args = ['run', 'dev']
    }

    this.emit('log', `[handybuilder] Running: ${cmd} ${args.join(' ')}\n`)

    const proc = spawn(cmd, args, {
      cwd: projectPath,
      shell: true,
      env: {
        ...process.env,
        HANDYBUILDER_BABEL_CORE_PATH: require.resolve('@babel/core')
      }
    })
    this.process = proc

    const handleOutput = (data: Buffer): void => {
      const text = data.toString()
      this.emit('log', text)

      if (!this.detectedUrl) {
        const url = detectUrl(text)
        if (url) {
          this.detectedUrl = url
          this.emit('url', url)
          this.emit('status', 'running')
        }
      }
    }

    proc.stdout?.on('data', handleOutput)
    proc.stderr?.on('data', handleOutput)

    // Only clear this.process if it still refers to this specific child — a reload
    // may have already spawned a new process before this exit event fires.
    proc.on('exit', (code) => {
      this.emit('log', `[handybuilder] Dev server exited (code ${code})\n`)
      this.emit('status', 'stopped')
      if (this.process === proc) this.process = null
    })

    proc.on('error', (err) => {
      this.emit('log', `[handybuilder] Failed to start dev server: ${err.message}\n`)
      this.emit('status', 'error')
      if (this.process === proc) this.process = null
    })
  }

  async stop(): Promise<void> {
    if (!this.process) return
    this.process.kill()
    this.process = null
    this.detectedUrl = null
  }

  getUrl(): string | null {
    return this.detectedUrl
  }

  private runNpmInstall(projectPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npm', ['install'], {
        cwd: projectPath,
        shell: true,
        env: { ...process.env }
      })

      proc.stdout?.on('data', (data: Buffer) => this.emit('log', data.toString()))
      proc.stderr?.on('data', (data: Buffer) => this.emit('log', data.toString()))

      proc.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`npm install exited with code ${code}`))
      })

      proc.on('error', reject)
    })
  }

  private emit(event: 'url', value: string): void
  private emit(event: 'log', value: string): void
  private emit(event: 'status', value: DevServerStatus): void
  private emit(event: string, value: unknown): void {
    if (event === 'url') this.callbacks.onUrlDetected?.(value as string)
    if (event === 'log') this.callbacks.onLog?.(value as string)
    if (event === 'status') this.callbacks.onStatusChange?.(value as DevServerStatus)
  }
}
