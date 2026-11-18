import type { ModelCatalogEntry, ModelReasoningOption, ModelSettingsConfig } from '@cpa/plugin-api'
import { compareModelsByName, filterReasoningOptionsBySettings } from './modelMenuOptions.js'

export interface PeriodicElementDefinition {
    readonly number: number
    readonly symbol: string
    readonly name: string
    readonly zhName: string
    readonly row: number
    readonly col: number
    readonly aliases?: readonly string[]
}

export interface PeriodicSeriesPlaceholder {
    readonly id: string
    readonly label: string
    readonly seriesLabel: string
    readonly row: number
    readonly col: number
    readonly kind: 'range'
}

export interface Gemini4ElementGroup {
    readonly element: PeriodicElementDefinition
    readonly models: readonly ModelCatalogEntry[]
}

export interface Gemini4GroupingResult {
    readonly gemini4Models: readonly ModelCatalogEntry[]
    readonly nonGemini4Models: readonly ModelCatalogEntry[]
    readonly elements: readonly Gemini4ElementGroup[]
    readonly elementMap: ReadonlyMap<number, Gemini4ElementGroup>
    readonly otherModels: readonly ModelCatalogEntry[]
    readonly releasedCount: number
    readonly firstGemini4Index: number
}

export const PERIODIC_SERIES_PLACEHOLDERS: readonly PeriodicSeriesPlaceholder[] = Object.freeze([
    { id: 'range-57-71', label: '57-71', seriesLabel: 'Ln', row: 6, col: 3, kind: 'range' },
    { id: 'range-89-103', label: '89-103', seriesLabel: 'An', row: 7, col: 3, kind: 'range' },
])

export const PERIODIC_ELEMENTS: readonly PeriodicElementDefinition[] = Object.freeze([
    // Period 1
    { number: 1, symbol: 'H', name: 'Hydrogen', zhName: '氢', row: 1, col: 1 },
    { number: 2, symbol: 'He', name: 'Helium', zhName: '氦', row: 1, col: 18 },
    // Period 2
    { number: 3, symbol: 'Li', name: 'Lithium', zhName: '锂', row: 2, col: 1 },
    { number: 4, symbol: 'Be', name: 'Beryllium', zhName: '铍', row: 2, col: 2 },
    { number: 5, symbol: 'B', name: 'Boron', zhName: '硼', row: 2, col: 13 },
    { number: 6, symbol: 'C', name: 'Carbon', zhName: '碳', row: 2, col: 14 },
    { number: 7, symbol: 'N', name: 'Nitrogen', zhName: '氮', row: 2, col: 15 },
    { number: 8, symbol: 'O', name: 'Oxygen', zhName: '氧', row: 2, col: 16 },
    { number: 9, symbol: 'F', name: 'Fluorine', zhName: '氟', row: 2, col: 17 },
    { number: 10, symbol: 'Ne', name: 'Neon', zhName: '氖', row: 2, col: 18 },
    // Period 3
    { number: 11, symbol: 'Na', name: 'Sodium', zhName: '钠', row: 3, col: 1 },
    { number: 12, symbol: 'Mg', name: 'Magnesium', zhName: '镁', row: 3, col: 2 },
    { number: 13, symbol: 'Al', name: 'Aluminium', zhName: '铝', row: 3, col: 13, aliases: ['Aluminum'] },
    { number: 14, symbol: 'Si', name: 'Silicon', zhName: '硅', row: 3, col: 14 },
    { number: 15, symbol: 'P', name: 'Phosphorus', zhName: '磷', row: 3, col: 15 },
    { number: 16, symbol: 'S', name: 'Sulfur', zhName: '硫', row: 3, col: 16, aliases: ['Sulphur'] },
    { number: 17, symbol: 'Cl', name: 'Chlorine', zhName: '氯', row: 3, col: 17 },
    { number: 18, symbol: 'Ar', name: 'Argon', zhName: '氩', row: 3, col: 18 },
    // Period 4
    { number: 19, symbol: 'K', name: 'Potassium', zhName: '钾', row: 4, col: 1 },
    { number: 20, symbol: 'Ca', name: 'Calcium', zhName: '钙', row: 4, col: 2 },
    { number: 21, symbol: 'Sc', name: 'Scandium', zhName: '钪', row: 4, col: 3 },
    { number: 22, symbol: 'Ti', name: 'Titanium', zhName: '钛', row: 4, col: 4 },
    { number: 23, symbol: 'V', name: 'Vanadium', zhName: '钒', row: 4, col: 5 },
    { number: 24, symbol: 'Cr', name: 'Chromium', zhName: '铬', row: 4, col: 6 },
    { number: 25, symbol: 'Mn', name: 'Manganese', zhName: '锰', row: 4, col: 7 },
    { number: 26, symbol: 'Fe', name: 'Iron', zhName: '铁', row: 4, col: 8 },
    { number: 27, symbol: 'Co', name: 'Cobalt', zhName: '钴', row: 4, col: 9 },
    { number: 28, symbol: 'Ni', name: 'Nickel', zhName: '镍', row: 4, col: 10 },
    { number: 29, symbol: 'Cu', name: 'Copper', zhName: '铜', row: 4, col: 11 },
    { number: 30, symbol: 'Zn', name: 'Zinc', zhName: '锌', row: 4, col: 12 },
    { number: 31, symbol: 'Ga', name: 'Gallium', zhName: '镓', row: 4, col: 13 },
    { number: 32, symbol: 'Ge', name: 'Germanium', zhName: '锗', row: 4, col: 14 },
    { number: 33, symbol: 'As', name: 'Arsenic', zhName: '砷', row: 4, col: 15 },
    { number: 34, symbol: 'Se', name: 'Selenium', zhName: '硒', row: 4, col: 16 },
    { number: 35, symbol: 'Br', name: 'Bromine', zhName: '溴', row: 4, col: 17 },
    { number: 36, symbol: 'Kr', name: 'Krypton', zhName: '氪', row: 4, col: 18 },
    // Period 5
    { number: 37, symbol: 'Rb', name: 'Rubidium', zhName: '铷', row: 5, col: 1 },
    { number: 38, symbol: 'Sr', name: 'Strontium', zhName: '锶', row: 5, col: 2 },
    { number: 39, symbol: 'Y', name: 'Yttrium', zhName: '钇', row: 5, col: 3 },
    { number: 40, symbol: 'Zr', name: 'Zirconium', zhName: '锆', row: 5, col: 4 },
    { number: 41, symbol: 'Nb', name: 'Niobium', zhName: '铌', row: 5, col: 5 },
    { number: 42, symbol: 'Mo', name: 'Molybdenum', zhName: '钼', row: 5, col: 6 },
    { number: 43, symbol: 'Tc', name: 'Technetium', zhName: '锝', row: 5, col: 7 },
    { number: 44, symbol: 'Ru', name: 'Ruthenium', zhName: '钌', row: 5, col: 8 },
    { number: 45, symbol: 'Rh', name: 'Rhodium', zhName: '铑', row: 5, col: 9 },
    { number: 46, symbol: 'Pd', name: 'Palladium', zhName: '钯', row: 5, col: 10 },
    { number: 47, symbol: 'Ag', name: 'Silver', zhName: '银', row: 5, col: 11 },
    { number: 48, symbol: 'Cd', name: 'Cadmium', zhName: '镉', row: 5, col: 12 },
    { number: 49, symbol: 'In', name: 'Indium', zhName: '铟', row: 5, col: 13 },
    { number: 50, symbol: 'Sn', name: 'Tin', zhName: '锡', row: 5, col: 14 },
    { number: 51, symbol: 'Sb', name: 'Antimony', zhName: '锑', row: 5, col: 15 },
    { number: 52, symbol: 'Te', name: 'Tellurium', zhName: '碲', row: 5, col: 16 },
    { number: 53, symbol: 'I', name: 'Iodine', zhName: '碘', row: 5, col: 17 },
    { number: 54, symbol: 'Xe', name: 'Xenon', zhName: '氙', row: 5, col: 18 },
    // Period 6
    { number: 55, symbol: 'Cs', name: 'Caesium', zhName: '铯', row: 6, col: 1, aliases: ['Cesium'] },
    { number: 56, symbol: 'Ba', name: 'Barium', zhName: '钡', row: 6, col: 2 },
    { number: 72, symbol: 'Hf', name: 'Hafnium', zhName: '铪', row: 6, col: 4 },
    { number: 73, symbol: 'Ta', name: 'Tantalum', zhName: '钽', row: 6, col: 5 },
    { number: 74, symbol: 'W', name: 'Tungsten', zhName: '钨', row: 6, col: 6 },
    { number: 75, symbol: 'Re', name: 'Rhenium', zhName: '铼', row: 6, col: 7 },
    { number: 76, symbol: 'Os', name: 'Osmium', zhName: '锇', row: 6, col: 8 },
    { number: 77, symbol: 'Ir', name: 'Iridium', zhName: '铱', row: 6, col: 9 },
    { number: 78, symbol: 'Pt', name: 'Platinum', zhName: '铂', row: 6, col: 10 },
    { number: 79, symbol: 'Au', name: 'Gold', zhName: '金', row: 6, col: 11 },
    { number: 80, symbol: 'Hg', name: 'Mercury', zhName: '汞', row: 6, col: 12 },
    { number: 81, symbol: 'Tl', name: 'Thallium', zhName: '铊', row: 6, col: 13 },
    { number: 82, symbol: 'Pb', name: 'Lead', zhName: '铅', row: 6, col: 14 },
    { number: 83, symbol: 'Bi', name: 'Bismuth', zhName: '铋', row: 6, col: 15 },
    { number: 84, symbol: 'Po', name: 'Polonium', zhName: '钋', row: 6, col: 16 },
    { number: 85, symbol: 'At', name: 'Astatine', zhName: '砹', row: 6, col: 17 },
    { number: 86, symbol: 'Rn', name: 'Radon', zhName: '氡', row: 6, col: 18 },
    // Period 7
    { number: 87, symbol: 'Fr', name: 'Francium', zhName: '钫', row: 7, col: 1 },
    { number: 88, symbol: 'Ra', name: 'Radium', zhName: '镭', row: 7, col: 2 },
    { number: 104, symbol: 'Rf', name: 'Rutherfordium', zhName: '𬬻', row: 7, col: 4 },
    { number: 105, symbol: 'Db', name: 'Dubnium', zhName: '𬭊', row: 7, col: 5 },
    { number: 106, symbol: 'Sg', name: 'Seaborgium', zhName: '𬭳', row: 7, col: 6 },
    { number: 107, symbol: 'Bh', name: 'Bohrium', zhName: '𬭛', row: 7, col: 7 },
    { number: 108, symbol: 'Hs', name: 'Hassium', zhName: '𬭶', row: 7, col: 8 },
    { number: 109, symbol: 'Mt', name: 'Meitnerium', zhName: '鿏', row: 7, col: 9 },
    { number: 110, symbol: 'Ds', name: 'Darmstadtium', zhName: '𫟼', row: 7, col: 10 },
    { number: 111, symbol: 'Rg', name: 'Roentgenium', zhName: '𬬭', row: 7, col: 11 },
    { number: 112, symbol: 'Cn', name: 'Copernicium', zhName: '鿔', row: 7, col: 12 },
    { number: 113, symbol: 'Nh', name: 'Nihonium', zhName: '鿭', row: 7, col: 13 },
    { number: 114, symbol: 'Fl', name: 'Flerovium', zhName: '𫓧', row: 7, col: 14 },
    { number: 115, symbol: 'Mc', name: 'Moscovium', zhName: '镆', row: 7, col: 15 },
    { number: 116, symbol: 'Lv', name: 'Livermorium', zhName: '𫟷', row: 7, col: 16 },
    { number: 117, symbol: 'Ts', name: 'Tennessine', zhName: '鿬', row: 7, col: 17 },
    { number: 118, symbol: 'Og', name: 'Oganesson', zhName: '鿫', row: 7, col: 18 },
    // Lanthanides (Row 8, Cols 4..18)
    { number: 57, symbol: 'La', name: 'Lanthanum', zhName: '镧', row: 8, col: 4 },
    { number: 58, symbol: 'Ce', name: 'Cerium', zhName: '铈', row: 8, col: 5 },
    { number: 59, symbol: 'Pr', name: 'Praseodymium', zhName: '镨', row: 8, col: 6 },
    { number: 60, symbol: 'Nd', name: 'Neodymium', zhName: '钕', row: 8, col: 7 },
    { number: 61, symbol: 'Pm', name: 'Promethium', zhName: '钷', row: 8, col: 8 },
    { number: 62, symbol: 'Sm', name: 'Samarium', zhName: '钐', row: 8, col: 9 },
    { number: 63, symbol: 'Eu', name: 'Europium', zhName: '铕', row: 8, col: 10 },
    { number: 64, symbol: 'Gd', name: 'Gadolinium', zhName: '钆', row: 8, col: 11 },
    { number: 65, symbol: 'Tb', name: 'Terbium', zhName: '铽', row: 8, col: 12 },
    { number: 66, symbol: 'Dy', name: 'Dysprosium', zhName: '镝', row: 8, col: 13 },
    { number: 67, symbol: 'Ho', name: 'Holmium', zhName: '钬', row: 8, col: 14 },
    { number: 68, symbol: 'Er', name: 'Erbium', zhName: '铒', row: 8, col: 15 },
    { number: 69, symbol: 'Tm', name: 'Thulium', zhName: '铥', row: 8, col: 16 },
    { number: 70, symbol: 'Yb', name: 'Ytterbium', zhName: '镱', row: 8, col: 17 },
    { number: 71, symbol: 'Lu', name: 'Lutetium', zhName: '镥', row: 8, col: 18 },
    // Actinides (Row 9, Cols 4..18)
    { number: 89, symbol: 'Ac', name: 'Actinium', zhName: '锕', row: 9, col: 4 },
    { number: 90, symbol: 'Th', name: 'Thorium', zhName: '钍', row: 9, col: 5 },
    { number: 91, symbol: 'Pa', name: 'Protactinium', zhName: '镤', row: 9, col: 6 },
    { number: 92, symbol: 'U', name: 'Uranium', zhName: '铀', row: 9, col: 7 },
    { number: 93, symbol: 'Np', name: 'Neptunium', zhName: '镎', row: 9, col: 8 },
    { number: 94, symbol: 'Pu', name: 'Plutonium', zhName: '钚', row: 9, col: 9 },
    { number: 95, symbol: 'Am', name: 'Americium', zhName: '镅', row: 9, col: 10 },
    { number: 96, symbol: 'Cm', name: 'Curium', zhName: '锔', row: 9, col: 11 },
    { number: 97, symbol: 'Bk', name: 'Berkelium', zhName: '锫', row: 9, col: 12 },
    { number: 98, symbol: 'Cf', name: 'Californium', zhName: '锎', row: 9, col: 13 },
    { number: 99, symbol: 'Es', name: 'Einsteinium', zhName: '锿', row: 9, col: 14 },
    { number: 100, symbol: 'Fm', name: 'Fermium', zhName: '镄', row: 9, col: 15 },
    { number: 101, symbol: 'Md', name: 'Mendelevium', zhName: '钔', row: 9, col: 16 },
    { number: 102, symbol: 'No', name: 'Nobelium', zhName: '锘', row: 9, col: 17 },
    { number: 103, symbol: 'Lr', name: 'Lawrencium', zhName: '铹', row: 9, col: 18 },
])

const ELEMENT_BY_NAME = new Map<string, PeriodicElementDefinition>()
const ELEMENT_BY_SYMBOL = new Map<string, PeriodicElementDefinition>()

for (const element of PERIODIC_ELEMENTS) {
    ELEMENT_BY_NAME.set(element.name.toLowerCase(), element)
    if (element.aliases) {
        for (const alias of element.aliases) {
            ELEMENT_BY_NAME.set(alias.toLowerCase(), element)
        }
    }
    ELEMENT_BY_SYMBOL.set(element.symbol.toLowerCase(), element)
}

const GEMINI_4_PREFIX_RE = /^gemini[\s-]+4(?:[\s-]+|$)/i
const GEMINI_4_STRIP_RE = /^gemini[\s-]+4[\s-]*/i

export function isGemini4PeriodicTableEnabled(modelSettings?: ModelSettingsConfig): boolean {
    return modelSettings?.gemini4PeriodicTable !== false
}

export function isGemini4Model(model: ModelCatalogEntry): boolean {
    const displayName = (model.label?.trim() || model.id).trim()
    return GEMINI_4_PREFIX_RE.test(displayName)
}

function stripGemini4Prefix(raw: string): string {
    const trimmed = raw.trim()
    const slashIdx = trimmed.lastIndexOf('/')
    const base = slashIdx >= 0 ? trimmed.slice(slashIdx + 1) : trimmed
    return base.replace(GEMINI_4_STRIP_RE, '').trim()
}

function tokenizeCandidate(candidate: string): string[] {
    return candidate
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean)
}

function matchElementByName(candidate: string): PeriodicElementDefinition | null {
    if (!candidate) return null
    for (const token of tokenizeCandidate(candidate)) {
        const matched = ELEMENT_BY_NAME.get(token)
        if (matched) return matched
    }
    return null
}

function matchElementByFirstTokenSymbol(candidate: string): PeriodicElementDefinition | null {
    if (!candidate) return null
    // Only allow exact chemical symbol match on the first standalone token
    // to prevent channel suffixes like "SU" from matching elements accidentally
    const firstToken = tokenizeCandidate(candidate)[0]
    if (!firstToken) return null
    return ELEMENT_BY_SYMBOL.get(firstToken) ?? null
}

export function resolveGemini4Element(model: ModelCatalogEntry): PeriodicElementDefinition | null {
    if (!isGemini4Model(model)) return null
    const candidates: string[] = []
    if (model.label?.trim()) {
        candidates.push(stripGemini4Prefix(model.label))
    }
    const strippedId = stripGemini4Prefix(model.id)
    if (strippedId) {
        candidates.push(strippedId)
    }

    // Prefer full IUPAC/alias element names across both label and id before symbol fallback
    for (const candidate of candidates) {
        const matched = matchElementByName(candidate)
        if (matched) return matched
    }
    for (const candidate of candidates) {
        const matched = matchElementByFirstTokenSymbol(candidate)
        if (matched) return matched
    }
    return null
}

export function extractGemini4VariantLabel(
    model: ModelCatalogEntry,
    element?: PeriodicElementDefinition,
): string | null {
    const rawName = (model.label?.trim() || model.id).trim()
    let remainder = rawName.replace(GEMINI_4_STRIP_RE, '').trim()
    if (element) {
        const namesToStrip = [element.name, ...(element.aliases ?? []), element.symbol]
        for (const name of namesToStrip) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            const re = new RegExp(`^${escaped}\\b`, 'i')
            if (re.test(remainder)) {
                remainder = remainder.replace(re, '').trim()
                break
            }
        }
    }
    remainder = remainder.replace(/^[-_:\s]+/, '').trim()
    if (remainder.startsWith('(') && remainder.endsWith(')') && remainder.length > 2) {
        remainder = remainder.slice(1, -1).trim()
    }
    return remainder || null
}

export function filterModelReasoningOptions(
    model: ModelCatalogEntry | undefined,
    modelSettings?: ModelSettingsConfig,
): readonly ModelReasoningOption[] {
    return filterReasoningOptionsBySettings(model, modelSettings)
}

export function groupGemini4Models(
    models: readonly ModelCatalogEntry[],
): Gemini4GroupingResult {
    const gemini4Models: ModelCatalogEntry[] = []
    const nonGemini4Models: ModelCatalogEntry[] = []
    const elementBuckets = new Map<number, { element: PeriodicElementDefinition; models: ModelCatalogEntry[] }>()
    const otherModels: ModelCatalogEntry[] = []
    let firstGemini4Index = -1

    models.forEach((model, index) => {
        if (!isGemini4Model(model)) {
            nonGemini4Models.push(model)
            return
        }
        if (firstGemini4Index === -1) {
            firstGemini4Index = index
        }
        gemini4Models.push(model)

        const element = resolveGemini4Element(model)
        if (!element) {
            otherModels.push(model)
            return
        }
        let bucket = elementBuckets.get(element.number)
        if (!bucket) {
            bucket = { element, models: [] }
            elementBuckets.set(element.number, bucket)
        }
        bucket.models.push(model)
    })

    const elementMap = new Map<number, Gemini4ElementGroup>()
    const elements: Gemini4ElementGroup[] = [...elementBuckets.values()]
        .sort((a, b) => a.element.number - b.element.number)
        .map((bucket) => {
            const sortedModels = [...bucket.models].sort((a, b) => {
                const aSuffix = extractGemini4VariantLabel(a, bucket.element)
                const bSuffix = extractGemini4VariantLabel(b, bucket.element)
                if (aSuffix === null && bSuffix !== null) return -1
                if (aSuffix !== null && bSuffix === null) return 1
                return compareModelsByName(a, b)
            })
            const group: Gemini4ElementGroup = {
                element: bucket.element,
                models: sortedModels,
            }
            elementMap.set(bucket.element.number, group)
            return group
        })

    const sortedOtherModels = [...otherModels].sort(compareModelsByName)

    return {
        gemini4Models,
        nonGemini4Models,
        elements,
        elementMap,
        otherModels: sortedOtherModels,
        releasedCount: elements.length,
        firstGemini4Index,
    }
}

export type QuickModelPickerItem =
    | {
          kind: 'model'
          id: string
          label: string
          description: string
          model: ModelCatalogEntry
      }
    | {
          kind: 'gemini4-group'
          id: '__gemini4_group__'
          label: string
          description: string
          releasedCount: number
          containsCurrentModel: boolean
      }

export function shouldGroupGemini4InQuickPicker(rawQuery: string): boolean {
    const q = rawQuery.trim().toLowerCase()
    if (!q) return true
    if ('gemini 4'.startsWith(q) || 'gemini-4'.startsWith(q)) return true
    if (
        (q.length >= 3 && ('periodic table'.startsWith(q) || q === 'table')) ||
        (q.length >= 2 && '元素周期表'.includes(q))
    ) {
        return true
    }
    return false
}

export function buildQuickModelPickerItems(options: {
    models: readonly ModelCatalogEntry[]
    currentModelId: string
    searchQuery?: string
    enableGemini4Grouping?: boolean
    groupLabel?: string
    groupDescription?: string
}): QuickModelPickerItem[] {
    const {
        models,
        currentModelId,
        searchQuery = '',
        enableGemini4Grouping = false,
        groupLabel = 'Gemini 4',
        groupDescription,
    } = options
    const q = searchQuery.trim().toLowerCase()
    const grouped = groupGemini4Models(models)
    const canShowPeriodicEntry =
        enableGemini4Grouping &&
        grouped.gemini4Models.length > 0 &&
        shouldGroupGemini4InQuickPicker(searchQuery)

    // Always retain the complete expanded model list in QuickModelPicker even when the periodic table entry is shown
    const sorted = [...models].sort(compareModelsByName)
    const filtered = !q
        ? sorted
        : sorted.filter((model) => {
              const labelMatch = (model.label || model.id).toLowerCase().includes(q)
              const idMatch = model.id.toLowerCase().includes(q)
              const descMatch = model.description?.toLowerCase().includes(q) ?? false
              return labelMatch || idMatch || descMatch
          })

    const items: QuickModelPickerItem[] = filtered.map((model) => ({
        kind: 'model',
        id: model.id,
        label: model.label || model.id,
        description: model.description || model.id,
        model,
    }))

    if (!canShowPeriodicEntry) {
        return items
    }

    const groupItem: QuickModelPickerItem = {
        kind: 'gemini4-group',
        id: '__gemini4_group__',
        label: groupLabel,
        description:
            groupDescription ?? `${grouped.releasedCount} released · Periodic table`,
        releasedCount: grouped.releasedCount,
        containsCurrentModel: grouped.gemini4Models.some((m) => m.id === currentModelId),
    }

    const insertIndex = items.findIndex(
        (item) =>
            item.label.localeCompare(groupItem.label, undefined, { numeric: true, sensitivity: 'base' }) > 0,
    )
    if (insertIndex === -1) {
        items.push(groupItem)
    } else {
        items.splice(insertIndex, 0, groupItem)
    }
    return items
}
