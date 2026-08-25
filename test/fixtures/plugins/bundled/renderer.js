export default {
  manifest: {
    id: 'cpa.fixture.bundled',
    name: 'Fixture Bundled Plugin',
    version: '1.0.0',
    apiVersion: '1.0.0',
    engines: { cpa: '>=1.0.0' },
  },
  activate(context) {
    context.registerSlotComponent?.('chat-header', {
      id: 'bundled-slot-header',
      component: () => null,
      order: 10,
    })
  },
  deactivate() {},
}
