export default {
  manifest: {
    id: 'cpa.fixture.npm',
    name: 'Fixture NPM Plugin',
    version: '1.0.0',
    apiVersion: '1.0.0',
    engines: { cpa: '>=1.0.0' },
  },
  activate(context) {
    context.register({
      kind: 'service',
      id: 'npmService',
      value: {
        source: 'npm',
      },
    })
  },
  deactivate() {},
}
