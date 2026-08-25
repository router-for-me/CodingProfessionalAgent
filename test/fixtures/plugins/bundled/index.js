export default {
  manifest: {
    id: 'cpa.fixture.bundled',
    name: 'Fixture Bundled Plugin',
    version: '1.0.0',
    apiVersion: '1.0.0',
    engines: { cpa: '>=1.0.0' },
  },
  activate(context) {
    context.register({
      kind: 'service',
      id: 'bundledService',
      value: {
        source: 'bundled',
        ping: () => 'bundled-pong',
      },
    })
  },
  deactivate() {},
}
