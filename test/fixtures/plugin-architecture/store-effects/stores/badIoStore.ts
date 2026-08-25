import * as fs from 'node:fs'

export function useBadIoStore() {
    return {
        loadData: async () => {
            const resp = await fetch('https://api.example.com/data')
            return resp.json()
        },
        readConfig: () => {
            return fs.readFileSync('/tmp/config')
        },
    }
}
