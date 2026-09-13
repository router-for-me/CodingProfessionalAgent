import '@testing-library/jest-dom/vitest'

// Ensure reliable localStorage in Node jsdom test environment
if (typeof window !== 'undefined') {
  const createMockStorage = (): Storage => {
    let store = new Map<string, string>()
    return {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value))
      },
      removeItem: (key: string) => {
        store.delete(key)
      },
      clear: () => {
        store.clear()
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size
      },
    }
  }

  try {
    window.localStorage.clear()
  } catch {
    const mock = createMockStorage()
    Object.defineProperty(window, 'localStorage', {
      value: mock,
      writable: true,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'localStorage', {
      value: mock,
      writable: true,
      configurable: true,
    })
  }
}

