import { funcA } from './cycle-a'

export function funcC() {
    return funcA()
}
