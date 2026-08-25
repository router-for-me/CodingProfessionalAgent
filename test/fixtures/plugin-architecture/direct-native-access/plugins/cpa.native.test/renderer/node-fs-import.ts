import * as fs from 'node:fs'

export function doNodeFs() {
    return fs.readFileSync('/tmp/test')
}
