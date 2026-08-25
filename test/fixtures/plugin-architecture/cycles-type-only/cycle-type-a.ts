import type { TypeB } from './cycle-type-b'

export interface TypeA {
    b?: TypeB
}
export const valA = 1
