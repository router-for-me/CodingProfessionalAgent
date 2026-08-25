export async function doDynamicEvals(name: string) {
    const r = require
    r('electron')

    eval("require('node:fs')")
    ;(process as any).getBuiltinModule('node:fs')
    new Function("return require('node:child_process')")()
    const mod1 = await import(`node:${name}`)
    const mod2 = await import('unsafe-external-unapproved-package')
    return { mod1, mod2 }
}
