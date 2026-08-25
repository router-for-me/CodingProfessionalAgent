import { funcC } from './cycle-c'

export function funcB() {
    return funcC()
}
