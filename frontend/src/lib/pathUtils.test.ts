import { describe, expect, it } from 'vitest'
import {
  getBaseName,
  getParentPath,
  getPathSegments,
  isWindowsPath,
  joinPath,
  normalizePath,
} from './pathUtils'

describe('pathUtils', () => {
  describe('isWindowsPath', () => {
    it('detects Windows drive paths', () => {
      expect(isWindowsPath('C:\\Users\\luis')).toBe(true)
      expect(isWindowsPath('c:/Users/luis')).toBe(true)
      expect(isWindowsPath('D:\\workspace')).toBe(true)
      expect(isWindowsPath('C:\\')).toBe(true)
    })

    it('detects POSIX paths', () => {
      expect(isWindowsPath('/Users/luis')).toBe(false)
      expect(isWindowsPath('/etc/nginx')).toBe(false)
      expect(isWindowsPath('/')).toBe(false)
    })
  })

  describe('normalizePath', () => {
    it('normalizes POSIX paths', () => {
      expect(normalizePath('/Users/luis/')).toBe('/Users/luis')
      expect(normalizePath('/Users//luis/repo')).toBe('/Users/luis/repo')
      expect(normalizePath('/')).toBe('/')
      expect(normalizePath('')).toBe('/')
    })

    it('normalizes Windows paths', () => {
      expect(normalizePath('C:\\Users\\luis\\')).toBe('C:\\Users\\luis')
      expect(normalizePath('C:/Users/luis')).toBe('C:\\Users\\luis')
      expect(normalizePath('C:\\')).toBe('C:\\')
      expect(normalizePath('C:')).toBe('C:\\')
    })
  })

  describe('getParentPath', () => {
    it('returns parent directory for POSIX paths', () => {
      expect(getParentPath('/Users/luis/projects')).toBe('/Users/luis')
      expect(getParentPath('/Users/luis')).toBe('/Users')
      expect(getParentPath('/Users')).toBe('/')
      expect(getParentPath('/')).toBe('/')
    })

    it('returns parent directory for Windows paths', () => {
      expect(getParentPath('C:\\Users\\luis\\projects')).toBe('C:\\Users\\luis')
      expect(getParentPath('C:\\Users\\luis')).toBe('C:\\Users')
      expect(getParentPath('C:\\Users')).toBe('C:\\')
      expect(getParentPath('C:\\')).toBe('C:\\')
    })
  })

  describe('joinPath', () => {
    it('joins POSIX path segments', () => {
      expect(joinPath('/Users/luis', 'projects')).toBe('/Users/luis/projects')
      expect(joinPath('/', 'home')).toBe('/home')
      expect(joinPath('/Users/luis/', '/projects/')).toBe('/Users/luis/projects')
    })

    it('joins Windows path segments', () => {
      expect(joinPath('C:\\Users', 'luis')).toBe('C:\\Users\\luis')
      expect(joinPath('C:\\', 'Users')).toBe('C:\\Users')
      expect(joinPath('C:\\Users\\', '\\luis\\')).toBe('C:\\Users\\luis')
    })
  })

  describe('getPathSegments', () => {
    it('returns breadcrumbs for POSIX path', () => {
      const segments = getPathSegments('/Users/luis/projects')
      expect(segments).toEqual([
        { name: '/', path: '/' },
        { name: 'Users', path: '/Users' },
        { name: 'luis', path: '/Users/luis' },
        { name: 'projects', path: '/Users/luis/projects' },
      ])
    })

    it('returns breadcrumbs for root POSIX path', () => {
      const segments = getPathSegments('/')
      expect(segments).toEqual([{ name: '/', path: '/' }])
    })

    it('returns breadcrumbs for Windows path', () => {
      const segments = getPathSegments('C:\\Users\\luis')
      expect(segments).toEqual([
        { name: 'C:\\', path: 'C:\\' },
        { name: 'Users', path: 'C:\\Users' },
        { name: 'luis', path: 'C:\\Users\\luis' },
      ])
    })
  })

  describe('getBaseName', () => {
    it('returns base name for POSIX paths', () => {
      expect(getBaseName('/Users/luis/projects')).toBe('projects')
      expect(getBaseName('/Users')).toBe('Users')
      expect(getBaseName('/')).toBe('/')
    })

    it('returns base name for Windows paths', () => {
      expect(getBaseName('C:\\Users\\luis')).toBe('luis')
      expect(getBaseName('C:\\Users')).toBe('Users')
      expect(getBaseName('C:\\')).toBe('C:\\')
    })
  })
})
