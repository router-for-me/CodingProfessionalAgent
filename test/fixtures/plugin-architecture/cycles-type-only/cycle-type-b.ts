import { type TypeA } from './cycle-type-a'

export interface TypeB {
    a?: TypeA
}
export const valB = 2
