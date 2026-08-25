export default {
  manifest: {
    id: 'cpa.fixture.local',
    name: 'Fixture Local Plugin',
    version: '1.0.0',
    apiVersion: '1.0.0',
    engines: { cpa: '>=1.0.0' },
  },
  activate(context) {
    context.register({
      kind: 'service',
      id: 'localService',
      value: {
        source: 'local',
      },
    })
  },
  deactivate() {},
}
