import React from 'react'

export function activate(ctx: any) {
    // 1. Const array with for-of loop
    const VIEWS = [
        { id: 'declared-view', title: 'Declared' },
        { id: 'undeclared-loop-view', title: 'Undeclared Loop' },
    ]
    for (const v of VIEWS) {
        ctx.registerView(v)
    }

    // 2. Array forEach with object literal
    ;['undeclared-array-view'].forEach((id) => {
        ctx.registerView({ id, title: 'Array' })
    })

    // 3. Helper function call
    function registerCustomView(id: string) {
        ctx.registerView({ id, title: 'Custom' })
    }
    registerCustomView('undeclared-helper-view')

    // 4. Object spread
    const baseConfig = { title: 'Spread' }
    ctx.registerView({ id: 'undeclared-spread-view', ...baseConfig })
}
