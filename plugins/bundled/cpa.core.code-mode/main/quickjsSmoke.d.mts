export interface QuickJSSmokeResult {
    sum: number
    callback: number
    callbackCount: number
    asyncResolved: boolean
}

export function runQuickJSSmoke(): Promise<QuickJSSmokeResult>
