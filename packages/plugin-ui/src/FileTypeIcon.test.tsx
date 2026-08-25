import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { FileTypeIcon } from './FileTypeIcon.js'

describe('FileTypeIcon', () => {
    it('renders language badge for ts/tsx/js/go/rs/py files', () => {
        const { container: tsContainer } = render(<FileTypeIcon name="main.ts" />)
        expect(tsContainer.textContent).toContain('TS')

        const { container: goContainer } = render(<FileTypeIcon name="main.go" />)
        expect(goContainer.textContent).toContain('GO')

        const { container: rsContainer } = render(<FileTypeIcon name="lib.rs" />)
        expect(rsContainer.textContent).toContain('RS')

        const { container: pyContainer } = render(<FileTypeIcon name="script.py" />)
        expect(pyContainer.textContent).toContain('PY')

        const { container: jsContainer } = render(<FileTypeIcon name="index.js" />)
        expect(jsContainer.textContent).toContain('JS')

        const { container: jsonContainer } = render(<FileTypeIcon name="package.json" />)
        expect(jsonContainer.textContent).toContain('{}')
    })

    it('renders SVG icon for dockerfile, gitignore, markdown, yaml, and sh', () => {
        const { container: dockerContainer } = render(<FileTypeIcon name="Dockerfile" />)
        expect(dockerContainer.querySelector('svg')).toBeInTheDocument()

        const { container: mdContainer } = render(<FileTypeIcon name="README.md" />)
        expect(mdContainer.querySelector('svg')).toBeInTheDocument()

        const { container: yamlContainer } = render(<FileTypeIcon name="config.yaml" />)
        expect(yamlContainer.querySelector('svg')).toBeInTheDocument()

        const { container: gitContainer } = render(<FileTypeIcon name=".gitignore" />)
        expect(gitContainer.querySelector('svg')).toBeInTheDocument()

        const { container: shContainer } = render(<FileTypeIcon name="build.sh" />)
        expect(shContainer.querySelector('svg')).toBeInTheDocument()
    })

    it('renders fallback icon for unknown file types', () => {
        const { container } = render(<FileTypeIcon name="unknown.xyz" />)
        expect(container.querySelector('svg')).toBeInTheDocument()
    })
})
