import { funcB } from './cycle-b'

export function funcA() {
    return funcB()
}
